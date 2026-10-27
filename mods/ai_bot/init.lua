-- ai_bot: the game's end of the bridge to the sidecar (server/game.mjs). A mod cannot listen for requests, so
-- once a second it posts what happened (chat, joins, leaves, where everyone is, how the last actions went) to
-- the sidecar, and does what the answer asks: say, give, teleport, heal, set the time, place blocks, kick.
-- The thinking happens in the sidecar; this file only reports and carries out, checking each action again.
--
-- Needs, in minetest.conf (server/luanti.mjs writes them): secure.http_mods = ai_bot,
-- ai_bot.bridge_url and ai_bot.bridge_key.

-- Must be asked for here, at load, and kept local: no other mod may reach it.
local http = core.request_http_api()
local url = core.settings:get("ai_bot.bridge_url")
local key = core.settings:get("ai_bot.bridge_key")

if not http or not url or not key then
	core.log("error", "[ai_bot] off: needs secure.http_mods = ai_bot, ai_bot.bridge_url and ai_bot.bridge_key")
	return
end

local INTERVAL = 1.0
local EVENTS_MAX = 200
local WORLD_LIMIT = 30000
local BOT_COLOR = "#f2b84b"
local DISCORD_COLOR = "#9aa8ff"

-- A colour from the sidecar, if it is one ("#rrggbb"), else the fallback.
local function hex(c, fallback)
	return type(c) == "string" and c:match("^#%x%x%x%x%x%x$") and c or fallback
end

local events = {}
local results = {}
local in_flight = false
local started = false
local elapsed = 0

local function push(event)
	if #events >= EVENTS_MAX then table.remove(events, 1) end
	events[#events + 1] = event
end

-- One line of chat: no control characters (they carry colors and formspec escapes), bounded.
local function line(s, max)
	return tostring(s or ""):gsub("%c", " "):sub(1, max or 400)
end

local function item_names()
	local names = {}
	for name in pairs(core.registered_items) do
		if name ~= "" and name ~= "unknown" and name ~= "ignore" then names[#names + 1] = name end
	end
	table.sort(names)
	return names
end

local function snapshot()
	local players = {}
	for _, player in ipairs(core.get_connected_players()) do
		local name = player:get_player_name()
		local privs = {}
		for priv in pairs(core.get_player_privs(name)) do privs[#privs + 1] = priv end
		players[#players + 1] = { name = name, pos = player:get_pos(), hp = player:get_hp(), privs = privs }
	end
	return players
end

local function in_world(x, y, z)
	return type(x) == "number" and type(y) == "number" and type(z) == "number"
		and math.abs(x) < WORLD_LIMIT and math.abs(y) < WORLD_LIMIT and math.abs(z) < WORLD_LIMIT
end

-- Each returns ok, message.
local actions = {}

function actions.say(a)
	local text = line(a.text)
	if a.from then
		local color = hex(a.color, a.from:sub(1, 9) == "[Discord]" and DISCORD_COLOR or BOT_COLOR)
		text = core.colorize(color, "<" .. line(a.from, 48) .. "> ") .. text
	end
	if a.to then
		if not core.get_player_by_name(a.to) then return false, a.to .. " is not online." end
		core.chat_send_player(a.to, text)
	else
		core.chat_send_all(text)
	end
	return true, "Said."
end

function actions.give(a)
	local player = core.get_player_by_name(a.player)
	if not player then return false, tostring(a.player) .. " is not online." end
	if not core.registered_items[a.item] then return false, "There is no item called " .. tostring(a.item) .. "." end
	local count = math.max(1, math.min(99, math.floor(tonumber(a.count) or 1)))
	local leftover = player:get_inventory():add_item("main", ItemStack(a.item .. " " .. count))
	if not leftover:is_empty() then
		core.add_item(player:get_pos(), leftover)
		return true, "Gave " .. (count - leftover:get_count()) .. "; the inventory was full, so "
			.. leftover:get_count() .. " were dropped at their feet."
	end
	return true, "Gave " .. count .. " " .. a.item .. " to " .. a.player .. "."
end

function actions.teleport(a)
	local player = core.get_player_by_name(a.player)
	if not player then return false, tostring(a.player) .. " is not online." end
	if not in_world(a.x, a.y, a.z) then return false, "That position is outside the world." end
	player:set_pos({ x = a.x, y = a.y, z = a.z })
	return true, "Moved " .. a.player .. " to " .. a.x .. ", " .. a.y .. ", " .. a.z .. "."
end

function actions.heal(a)
	local player = core.get_player_by_name(a.player)
	if not player then return false, tostring(a.player) .. " is not online." end
	player:set_hp(player:get_properties().hp_max or 20)
	return true, "Healed " .. a.player .. "."
end

function actions.time(a)
	local value = tonumber(a.value)
	if not value or value < 0 or value > 1 then return false, "Time is from 0 to 1." end
	core.set_timeofday(value)
	return true, "Time set."
end

function actions.place(a)
	if type(a.nodes) ~= "table" or #a.nodes == 0 then return false, "No blocks to place." end
	local lo, hi
	for _, n in ipairs(a.nodes) do
		if not in_world(n.x, n.y, n.z) then return false, "A block is outside the world." end
		if n.item ~= "air" and not core.registered_nodes[n.item] then
			return false, tostring(n.item) .. " is not a block that can be placed."
		end
		lo = lo and vector.new(math.min(lo.x, n.x), math.min(lo.y, n.y), math.min(lo.z, n.z)) or vector.new(n.x, n.y, n.z)
		hi = hi and vector.new(math.max(hi.x, n.x), math.max(hi.y, n.y), math.max(hi.z, n.z)) or vector.new(n.x, n.y, n.z)
	end
	-- Blocks nobody is near may not be loaded; load them, or set_node does nothing there.
	core.load_area(lo, hi)
	local placed, protected = 0, 0
	for _, n in ipairs(a.nodes) do
		local pos = vector.new(n.x, n.y, n.z)
		if core.is_protected(pos, "") then
			protected = protected + 1
		else
			core.set_node(pos, { name = n.item })
			placed = placed + 1
		end
	end
	return true, "Placed " .. placed .. " blocks" .. (protected > 0 and (", skipped " .. protected .. " protected") or "") .. "."
end

-- The surface of each column: the highest block a player could stand on, or water.
local GROUND_TOP, GROUND_BOTTOM = 120, -60
function actions.ground(a)
	if type(a.columns) ~= "table" then return false, "No columns." end
	local found = {}
	for _, c in ipairs(a.columns) do
		if not in_world(c.x, 0, c.z) then return false, "A column is outside the world." end
		core.load_area(vector.new(c.x, GROUND_BOTTOM, c.z), vector.new(c.x, GROUND_TOP, c.z))
		local hit = { x = c.x, z = c.z, y = nil, block = "not generated yet: a player has not been near" }
		for y = GROUND_TOP, GROUND_BOTTOM, -1 do
			local name = core.get_node(vector.new(c.x, y, c.z)).name
			local def = core.registered_nodes[name]
			if name ~= "air" and name ~= "ignore" and def
				and (def.walkable or def.liquidtype ~= "none") and def.drawtype ~= "plantlike" then
				hit.y, hit.block = y, name
				break
			end
		end
		found[#found + 1] = hit
	end
	return true, core.write_json(found)
end

function actions.kick(a)
	if not core.get_player_by_name(a.player) then return false, tostring(a.player) .. " is not online." end
	core.kick_player(a.player, line(a.reason, 200) ~= "" and line(a.reason, 200) or "Kicked by an admin.")
	return true, "Kicked " .. a.player .. "."
end

-- ---- The characters' bodies ----
-- Each character the sidecar names (server/character.mjs) has a body: a woman in a dress and long hair, in her
-- own colours, her name over her head. She is in the world whenever a player is online or she has work to do:
-- she walks after whoever she is talking to and goes to what she builds. Bodies are never saved with the map
-- (static_save off), so a world never fills with stale copies: when an area unloads they are gone, and the next
-- sync puts them back by a player.

local cast = {} -- id -> { name, chat, dress, hair }, as the sidecar last sent it
local order = {} -- the ids, in the sidecar's order
local bodies = {} -- id -> { obj, follow, work_pos, work_until, work_anim, look }
local has_model = core.get_modpath("player_api") ~= nil
local ANIM = { stand = { x = 0, y = 79 }, walk = { x = 168, y = 187 }, mine = { x = 189, y = 198 } }
local WALK_SPEED, NEAR, FAR = 4, 3, 40

-- Her skin: the base (face, hands, boots) with the dress and hair masks tinted in her colours.
local function skin(c)
	return "ai_bot_skin.png^(ai_bot_dress.png^[multiply:" .. hex(c.dress, "#2f7fd0")
		.. ")^(ai_bot_hair.png^[multiply:" .. hex(c.hair, "#6b4226") .. ")"
end

local function body(id)
	bodies[id] = bodies[id] or {}
	return bodies[id]
end
local function alive(b) return b.obj ~= nil and b.obj:get_pos() ~= nil end

local function anim(self, which)
	if not has_model or self._anim == which then return end
	self._anim = which
	self.object:set_animation(ANIM[which], which == "walk" and 30 or 20, 0)
end

core.register_entity("ai_bot:npc", {
	initial_properties = {
		physical = true,
		collide_with_objects = false,
		collisionbox = { -0.3, 0.0, -0.3, 0.3, 1.7, 0.3 },
		selectionbox = { -0.3, 0.0, -0.3, 0.3, 1.7, 0.3 },
		visual = has_model and "mesh" or "cube",
		mesh = has_model and "character.b3d" or nil,
		textures = has_model and { "ai_bot_skin.png" } or { "default_wood.png" },
		visual_size = has_model and { x = 1, y = 1 } or { x = 0.6, y = 1.7 },
		stepheight = 1.1,
		nametag = "",
		static_save = false,
	},
	on_activate = function(self)
		self.object:set_armor_groups({ immortal = 1 })
		self.object:set_acceleration({ x = 0, y = -9.81, z = 0 })
		self._stuck = 0
		anim(self, "stand")
	end,
	on_rightclick = function(self, clicker)
		local c = cast[self._cid]
		if not c then return end
		core.chat_send_player(clicker:get_player_name(), core.colorize(hex(c.chat, BOT_COLOR), "<" .. c.name .. "> ")
			.. "Talk to me in chat (say my name if others are around), or from the Discord channel!")
	end,
	on_step = function(self, dtime)
		local b = self._cid and bodies[self._cid]
		if not b or b.obj ~= self.object then
			self.object:remove() -- a body the sidecar no longer knows
			return
		end
		local obj = self.object
		local pos = obj:get_pos()
		local goal
		if b.work_pos and core.get_us_time() < b.work_until then
			goal = b.work_pos
		else
			b.work_pos = nil
			local p = b.follow and core.get_player_by_name(b.follow)
			goal = p and p:get_pos()
		end
		local vel = obj:get_velocity()
		if not goal then
			obj:set_velocity({ x = 0, y = vel.y, z = 0 })
			anim(self, "stand")
			return
		end
		local to = vector.subtract(goal, pos)
		local flat = math.sqrt(to.x * to.x + to.z * to.z)
		if flat > FAR or math.abs(to.y) > 12 then
			obj:set_pos(vector.add(goal, { x = 2, y = 0.5, z = 2 }))
			self._stuck = 0
			return
		end
		if flat > 0.01 then obj:set_yaw(core.dir_to_yaw({ x = to.x, y = 0, z = to.z })) end
		if flat > NEAR then
			obj:set_velocity({ x = to.x / flat * WALK_SPEED, y = vel.y, z = to.z / flat * WALK_SPEED })
			anim(self, "walk")
			-- Walking into a wall she cannot step over: hop to the goal after a couple of seconds.
			if math.abs(vel.x) + math.abs(vel.z) < 0.5 then self._stuck = self._stuck + dtime else self._stuck = 0 end
			if self._stuck > 2 then
				obj:set_pos(vector.add(goal, { x = 2, y = 0.5, z = 2 }))
				self._stuck = 0
			end
		else
			obj:set_velocity({ x = 0, y = vel.y, z = 0 })
			anim(self, b.work_pos and b.work_anim or "stand")
		end
	end,
})

-- Put a character's body in the world near `near`, a little apart from the others, dressed in her colours.
local function spawn(id, near)
	local c = cast[id]
	if not c then return end
	local i = 0
	for n, x in ipairs(order) do if x == id then i = n end end
	local obj = core.add_entity(vector.add(near, { x = 2 + i, y = 0.5, z = 2 - i }), "ai_bot:npc")
	if not obj then return end
	local ent = obj:get_luaentity()
	if ent then ent._cid = id end
	local b = body(id)
	b.obj, b.look = obj, nil
	obj:set_properties({ nametag = c.name, nametag_color = hex(c.chat, BOT_COLOR) })
	if has_model then obj:set_properties({ textures = { skin(c) } }) end
	b.look = c.name .. skin(c)
end

-- Walk after a player (and appear by them when not in the world).
local function follow(id, name)
	local p = name and core.get_player_by_name(name)
	if not p or not cast[id] then return end
	local b = body(id)
	b.follow = name
	if not alive(b) then spawn(id, p:get_pos()) end
end

-- Go to a site and work (or stand) there a while, appearing there if need be.
local function work(id, pos, how)
	if not cast[id] then return end
	local b = body(id)
	b.work_pos, b.work_until, b.work_anim = pos, core.get_us_time() + 10 * 1000000, how or "mine"
	if not alive(b) then spawn(id, pos) end
end

function actions.walk(a)
	if not in_world(a.x, a.y, a.z) then return false, "That position is outside the world." end
	work(a.by or order[1], vector.new(a.x, a.y, a.z), "stand")
	return true, "Walking to " .. a.x .. ", " .. a.y .. ", " .. a.z .. "."
end

-- Each sync: the cast as the sidecar has it, each in the world while anyone is, by the player she last followed
-- or one of those online (spread among them).
local function tend(list)
	if type(list) == "table" then
		local fresh, ids = {}, {}
		for _, c in ipairs(list) do
			if type(c) == "table" and type(c.id) == "string" and type(c.name) == "string" then
				fresh[c.id] = { name = line(c.name, 32), chat = c.chat, dress = c.dress, hair = c.hair }
				ids[#ids + 1] = c.id
			end
		end
		cast, order = fresh, ids
	end
	for id, b in pairs(bodies) do
		if not cast[id] then
			if alive(b) then b.obj:remove() end
			bodies[id] = nil
		end
	end
	local players = core.get_connected_players()
	for i, id in ipairs(order) do
		local b = body(id)
		local c = cast[id]
		if b.follow and not core.get_player_by_name(b.follow) then b.follow = nil end
		if not b.follow and #players > 0 then b.follow = players[(i - 1) % #players + 1]:get_player_name() end
		if alive(b) then
			if not b.follow and not b.work_pos then
				b.obj:remove()
				b.obj = nil
			elseif b.look ~= c.name .. skin(c) then
				b.obj:set_properties({ nametag = c.name, nametag_color = hex(c.chat, BOT_COLOR) })
				if has_model then b.obj:set_properties({ textures = { skin(c) } }) end
				b.look = c.name .. skin(c)
			end
		elseif b.follow then
			follow(id, b.follow)
		end
	end
end

-- What each action does to the body of the character who did it.
local function after(a)
	local id = a.by or order[1]
	if not id then return end
	if (a.type == "give" or a.type == "heal" or a.type == "teleport") and a.player then
		core.after(a.type == "teleport" and 0.5 or 0, follow, id, a.player)
	elseif a.type == "say" and a.near then
		follow(id, a.near)
	elseif a.type == "place" and type(a.nodes) == "table" and a.nodes[1] then
		local n = a.nodes[1]
		work(id, vector.new(n.x, n.y, n.z))
	end
end

local function run(a)
	local handler = actions[a.type]
	local ok, message
	if not handler then
		ok, message = false, "This mod does not know " .. tostring(a.type) .. "."
	else
		local fine, r1, r2 = pcall(handler, a)
		if fine then ok, message = r1, r2 else ok, message = false, "Failed: " .. tostring(r1) end
	end
	if ok then
		local moved, err = pcall(after, a)
		if not moved then core.log("warning", "[ai_bot] body: " .. tostring(err)) end
	end
	if a.id then results[#results + 1] = { id = a.id, ok = ok, message = message } end
end

local function sync()
	if not started then
		push({ type = "start", items = item_names() })
		started = true
	end
	local sent_events, sent_results = events, results
	events, results = {}, {}
	in_flight = true
	http.fetch({
		url = url,
		method = "POST",
		timeout = 5,
		quiet = true,
		extra_headers = { "Content-Type: application/json", "X-Bridge-Key: " .. key },
		data = core.write_json({
			players = snapshot(), time = core.get_timeofday(), events = sent_events, results = sent_results,
		}),
	}, function(res)
		in_flight = false
		if not res.succeeded or res.code ~= 200 then
			-- The sidecar is restarting, or not up yet: keep what it has not heard, newest last.
			for i = #sent_events, 1, -1 do table.insert(events, 1, sent_events[i]) end
			while #events > EVENTS_MAX do table.remove(events, 1) end
			for _, r in ipairs(sent_results) do results[#results + 1] = r end
			return
		end
		local answer = core.parse_json(res.data)
		if type(answer) == "table" then
			local tended, err = pcall(tend, answer.characters)
			if not tended then core.log("warning", "[ai_bot] body: " .. tostring(err)) end
		end
		if type(answer) == "table" and type(answer.actions) == "table" then
			for _, a in ipairs(answer.actions) do
				if type(a) == "table" then run(a) end
			end
		end
	end)
end

core.register_globalstep(function(dtime)
	elapsed = elapsed + dtime
	if elapsed < INTERVAL or in_flight then return end
	elapsed = 0
	sync()
end)

core.register_on_chat_message(function(name, message)
	if message:sub(1, 1) ~= "/" then push({ type = "chat", name = name, text = line(message) }) end
	-- false: the message is shown to everyone as usual.
	return false
end)

core.register_on_joinplayer(function(player)
	push({ type = "join", name = player:get_player_name() })
end)

core.register_on_leaveplayer(function(player)
	push({ type = "leave", name = player:get_player_name() })
end)

core.log("action", "[ai_bot] bridge to " .. url)
