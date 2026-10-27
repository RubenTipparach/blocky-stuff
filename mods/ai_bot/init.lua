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
	local placed, protected, filled = 0, 0, 0
	for _, n in ipairs(a.nodes) do
		local pos = vector.new(n.x, n.y, n.z)
		if core.is_protected(pos, "") then
			protected = protected + 1
		elseif a.soft and core.get_node(pos).name ~= "air" then
			filled = filled + 1 -- a prank only fills empty air: it never removes or replaces a block
		else
			core.set_node(pos, { name = n.item })
			placed = placed + 1
		end
	end
	return true, "Placed " .. placed .. " blocks" .. (protected > 0 and (", skipped " .. protected .. " protected") or "")
		.. (filled > 0 and (", " .. filled .. " spots were not empty") or "") .. "."
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
-- own colours, her name over her head. She lives in the world like a player's things do: saved with the map
-- where she stands, so a player who walks away leaves her behind (owner, 2026-10-27: "Bots keep following me
-- around. They should not unless I order them to"). She turns to face whoever she answers, and walks only to
-- what she builds, to hand something over, or when asked (follow, come, walk; stay stops her). Bodies keep apart:
-- each takes her own place around a shared goal, and two that end up close step away from each other. Where each
-- one lives is kept in mod storage, so a body is only made anew the first time, or when she is called.

local cast = {} -- id -> { name, chat, dress, hair }, as the sidecar last sent it
local order = {} -- the ids, in the sidecar's order
local bodies = {} -- id -> { obj, follow, go, go_until, go_anim, face, face_until, home, look }
local has_model = core.get_modpath("player_api") ~= nil
local ANIM = { stand = { x = 0, y = 79 }, walk = { x = 168, y = 187 }, mine = { x = 189, y = 198 } }
local WALK_SPEED, FAR = 4, 40
local ARRIVE = 1.2 -- close enough to her place
local APART = 1.4 -- nearer than this to another body, and they step apart
local RING = 2.5 -- how far from a shared goal each takes her place
local storage = core.get_mod_storage()
local SAVE_EVERY = 5 -- seconds between noting where a body stands

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
-- Where she lives (last stood), across restarts.
local function home_of(id) return core.parse_json(storage:get_string("home:" .. id) ~= "" and storage:get_string("home:" .. id) or "null") end
local function set_home(id, pos)
	storage:set_string("home:" .. id, core.write_json({ x = math.floor(pos.x + 0.5), y = math.floor(pos.y + 0.5), z = math.floor(pos.z + 0.5) }))
end

-- Keep the map block she stands in loaded, player or no player (owner, 2026-10-27: "Is there a way to mark on the
-- server to stay loaded without the player"), so she stays awake: walks, builds, is there when someone comes. One
-- block per character, moved with her (max_forceloaded_blocks in luanti/minetest.conf leaves room).
local held = {} -- id -> { key, pos }
local function hold(id, pos)
	local key = core.hash_node_position(vector.floor(vector.divide(pos, 16)))
	local h = held[id]
	if h and h.key == key then return end
	if h then core.forceload_free_block(h.pos, true) end
	if core.forceload_block(pos, true) then held[id] = { key = key, pos = vector.round(pos) } else held[id] = nil end
end
local function release(id)
	if held[id] then core.forceload_free_block(held[id].pos, true) end
	held[id] = nil
end

-- Her place around a goal: each character a different angle on a ring, so two never aim for the same spot.
local function place_for(id, goal)
	local n, i = #order, 1
	for k, x in ipairs(order) do if x == id then i = k end end
	local angle = (i - 1) / math.max(n, 1) * 2 * math.pi + math.pi / 4
	return { x = goal.x + math.cos(angle) * RING, y = goal.y, z = goal.z + math.sin(angle) * RING }
end

local function anim(self, which)
	if not has_model or self._anim == which then return end
	self._anim = which
	self.object:set_animation(ANIM[which], which == "walk" and 30 or 20, 0)
end

-- Where she is headed now: a place she was sent (for a while), else the player she follows, else nowhere.
local function goal_of(b)
	local now = core.get_us_time()
	if b.go and now < b.go_until then return b.go, b.go_anim end
	b.go = nil
	local p = b.follow and core.get_player_by_name(b.follow)
	if p then return p:get_pos(), "stand" end
	return nil
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
		static_save = true,
	},
	get_staticdata = function(self) return self._cid or "" end,
	on_activate = function(self, staticdata)
		-- A body saved with the map wakes up as her; if she is already up elsewhere (called away while this
		-- copy slept), this one goes.
		if staticdata and staticdata ~= "" then
			self._cid = staticdata
			local b = body(staticdata)
			if alive(b) and b.obj ~= self.object then
				self.object:remove()
				return
			end
			b.obj, b.look = self.object, nil
		end
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
		if not b or b.obj ~= self.object or (#order > 0 and not cast[self._cid]) then
			self.object:remove() -- a stray copy, or a character the sidecar no longer has
			return
		end
		local obj = self.object
		local pos = obj:get_pos()
		local vel = obj:get_velocity()
		self._saved = (self._saved or 0) + dtime
		if self._saved > SAVE_EVERY then
			self._saved = 0
			set_home(self._cid, pos)
			hold(self._cid, pos)
		end
		-- Step away from any other body standing too close.
		local push = { x = 0, z = 0 }
		for id, other in pairs(bodies) do
			if id ~= self._cid and alive(other) then
				local op = other.obj:get_pos()
				local dx, dz = pos.x - op.x, pos.z - op.z
				local d = math.sqrt(dx * dx + dz * dz)
				if d < APART and math.abs(pos.y - op.y) < 2 then
					if d < 0.05 then dx, dz, d = math.random() - 0.5, math.random() - 0.5, 0.5 end
					push.x, push.z = push.x + dx / d * 2, push.z + dz / d * 2
				end
			end
		end
		local goal, how = goal_of(b)
		local place = goal and place_for(self._cid, goal)
		if place then
			local to = vector.subtract(place, pos)
			local flat = math.sqrt(to.x * to.x + to.z * to.z)
			if flat > FAR or math.abs(to.y) > 12 then
				obj:set_pos(vector.add(place, { x = 0, y = 0.5, z = 0 }))
				self._stuck = 0
				return
			end
			if flat > ARRIVE then
				obj:set_yaw(core.dir_to_yaw({ x = to.x, y = 0, z = to.z }))
				obj:set_velocity({ x = to.x / flat * WALK_SPEED + push.x, y = vel.y, z = to.z / flat * WALK_SPEED + push.z })
				anim(self, "walk")
				-- Walking into a wall she cannot step over: hop to her place after a couple of seconds.
				if math.abs(vel.x) + math.abs(vel.z) < 0.5 then self._stuck = self._stuck + dtime else self._stuck = 0 end
				if self._stuck > 2 then
					obj:set_pos(vector.add(place, { x = 0, y = 0.5, z = 0 }))
					self._stuck = 0
				end
				return
			end
		end
		-- Arrived, or nowhere to go: stand (or work), facing what she is about.
		obj:set_velocity({ x = push.x, y = vel.y, z = push.z })
		local face = b.face and core.get_us_time() < b.face_until and core.get_player_by_name(b.face)
		local at = face and face:get_pos() or goal
		if at then
			local d = vector.subtract(at, pos)
			if math.abs(d.x) + math.abs(d.z) > 0.1 then obj:set_yaw(core.dir_to_yaw({ x = d.x, y = 0, z = d.z })) end
		end
		anim(self, (push.x ~= 0 or push.z ~= 0) and "walk" or (goal and how) or "stand")
	end,
})

-- Put a character's body in the world at `at` (her place around it), dressed in her colours.
local function spawn(id, at)
	local c = cast[id]
	if not c then return end
	local obj = core.add_entity(vector.add(place_for(id, at), { x = 0, y = 0.5, z = 0 }), "ai_bot:npc")
	if not obj then return end
	local ent = obj:get_luaentity()
	if ent then ent._cid = id end
	local b = body(id)
	b.obj = obj
	obj:set_properties({ nametag = c.name, nametag_color = hex(c.chat, BOT_COLOR) })
	if has_model then obj:set_properties({ textures = { skin(c) } }) end
	b.look = c.name .. skin(c)
	set_home(id, at)
end

-- Into the world near `at` if she is not up (she was called, or sent to work).
local function ensure(id, at)
	if cast[id] and not alive(body(id)) and at then spawn(id, at) end
end

-- Walk to a spot and be there a while (`how`: the animation while there), then stand, or go back to following
-- whoever asked her to.
local function go(id, pos, how)
	if not cast[id] or not pos then return end
	local b = body(id)
	b.go, b.go_until, b.go_anim = pos, core.get_us_time() + 15 * 1000000, how or "stand"
	ensure(id, pos)
end

-- Turn to face a player for a while (she answered them), if she is near; she does not come over for it.
local function face(id, name)
	if not cast[id] or not name then return end
	local b = body(id)
	b.face, b.face_until = name, core.get_us_time() + 20 * 1000000
end

local function player_pos(name)
	local p = name and core.get_player_by_name(name)
	return p and p:get_pos()
end

function actions.walk(a)
	if not in_world(a.x, a.y, a.z) then return false, "That position is outside the world." end
	body(a.by or order[1]).follow = nil -- sent somewhere: she stays there
	go(a.by or order[1], vector.new(a.x, a.y, a.z))
	return true, "Walking to " .. a.x .. ", " .. a.y .. ", " .. a.z .. "."
end

function actions.follow(a)
	local id = a.by or order[1]
	local at = player_pos(a.player)
	if not at then return false, tostring(a.player) .. " is not online." end
	local b = body(id)
	b.follow, b.go = a.player, nil
	ensure(id, at)
	return true, "Following " .. a.player .. " until they say stay."
end

function actions.come(a)
	local at = player_pos(a.player)
	if not at then return false, tostring(a.player) .. " is not online." end
	go(a.by or order[1], at)
	face(a.by or order[1], a.player)
	return true, "Walking over to " .. a.player .. "."
end

function actions.stay(a)
	local b = body(a.by or order[1])
	b.follow, b.go = nil, nil
	return true, "Staying put."
end

-- Each sync: the cast as the sidecar has it. A character who has never been in the world appears by a player the
-- first time one is online; after that she lives where she stood, saved with the map, and wakes when someone goes
-- there.
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
			storage:set_string("home:" .. id, "")
			release(id)
		end
	end
	local players = core.get_connected_players()
	for i, id in ipairs(order) do
		local b = body(id)
		local c = cast[id]
		if b.follow and not core.get_player_by_name(b.follow) then b.follow = nil end
		if alive(b) then
			b.waiting = nil
			if b.look ~= c.name .. skin(c) then
				b.obj:set_properties({ nametag = c.name, nametag_color = hex(c.chat, BOT_COLOR) })
				if has_model then b.obj:set_properties({ textures = { skin(c) } }) end
				b.look = c.name .. skin(c)
			end
		elseif home_of(id) then
			hold(id, home_of(id)) -- where she lives: load it, and she wakes there
			-- Still not up half a minute after her block loaded (her saved body was lost): make her anew there.
			b.waiting = b.waiting or core.get_us_time()
			if core.get_us_time() - b.waiting > 30 * 1000000 then
				b.waiting = nil
				spawn(id, home_of(id))
			end
		elseif #players > 0 then
			spawn(id, players[(i - 1) % #players + 1]:get_pos())
		end
	end
end

-- What each action does to the body of the character who did it: she goes over to hand something to a player,
-- works at what she builds, and faces whoever she answers.
local function after(a)
	local id = a.by or order[1]
	if not id then return end
	if (a.type == "give" or a.type == "heal") and a.player then
		go(id, player_pos(a.player))
		face(id, a.player)
	elseif a.type == "teleport" and a.player then
		core.after(0.5, function() face(id, a.player) end)
	elseif a.type == "say" and a.near then
		face(id, a.near)
	elseif a.type == "place" and type(a.nodes) == "table" and a.nodes[1] then
		local n = a.nodes[1]
		go(id, vector.new(n.x, n.y, n.z), "mine")
	end
end

-- ---- Talking to one of them, and how she feels about you ----

-- The character a player is looking at (within 12 blocks, about 20 degrees of where they look), else the nearest
-- within 5 blocks: who a line said in game is meant for when it names nobody (owner, 2026-10-27: "recognize when
-- I talk to one of them ... looking at someone when speaking").
local function looked_at(player, strict)
	local eye = vector.add(player:get_pos(), { x = 0, y = player:get_properties().eye_height or 1.5, z = 0 })
	local dir = player:get_look_dir()
	local best, best_cos, nearest, nearest_d = nil, strict and 0.97 or 0.94, nil, 5
	for id, b in pairs(bodies) do
		if cast[id] and alive(b) then
			local v = vector.subtract(vector.add(b.obj:get_pos(), { x = 0, y = 1.2, z = 0 }), eye)
			local d = vector.length(v)
			if d > 0.1 and d < (strict and 10 or 12) then
				local cos = vector.dot(vector.divide(v, d), dir)
				if cos > best_cos then best, best_cos = id, cos end
			end
			if d < nearest_d then nearest, nearest_d = id, d end
		end
	end
	return best or (not strict and nearest) or nil
end

-- A character by (the start of) her name.
local function named(text)
	local want = tostring(text or ""):lower()
	if want == "" then return nil end
	for _, id in ipairs(order) do
		if cast[id].name:lower() == want then return id end
	end
	for _, id in ipairs(order) do
		if cast[id].name:lower():sub(1, #want) == want then return id end
	end
	return nil
end

local function in_her_voice(to, id, text)
	local c = cast[id]
	core.chat_send_player(to, core.colorize(hex(c.chat, BOT_COLOR), "<" .. c.name .. "> ") .. text)
end

-- How each character feels about each player online, as the sidecar last sent it: meters[player][id] =
-- { a = affinity, t = trust, w = word, tw = trust word }.
local meters = {}

local function meter_line(player_name, id)
	local m = meters[player_name] and meters[player_name][id]
	local c = cast[id]
	if not m or not c then return c and c.name or "" end
	local filled = math.floor((m.a + 100) / 20 + 0.5)
	return string.format("%s  %s (%+d)  [%s%s]  trust: %s", c.name, m.w or "", m.a or 0, string.rep("|", filled),
		string.rep(".", 10 - filled), m.tw or "")
end

core.register_chatcommand("talk", {
	params = "<name> <message>",
	description = "Say something to one of the characters, by name",
	privs = { shout = true },
	func = function(name, param)
		local who, text = param:match("^(%S+)%s+(.+)$")
		local id = who and named(who)
		if not id then return false, "Say /talk <name> <message>; the characters are: " .. table.concat((function()
			local n = {} for _, x in ipairs(order) do n[#n + 1] = cast[x].name end return n end)(), ", ") end
		core.chat_send_all("<" .. name .. "> (to " .. cast[id].name .. ") " .. line(text))
		push({ type = "chat", name = name, text = line(text), target = id })
		return true
	end,
})

for _, cmd in ipairs({ "follow", "come", "stay" }) do
	core.register_chatcommand(cmd, {
		params = "<name>",
		description = ({ follow = "Have a character follow you until /stay", come = "Call a character over",
			stay = "Have a character stop and stay where she is" })[cmd],
		privs = { shout = true },
		func = function(name, param)
			local id = named(param:match("^%s*(%S+)"))
			if not id then return false, "Which one? /" .. cmd .. " <name>" end
			local ok, msg = actions[cmd]({ by = id, player = name })
			if ok then
				in_her_voice(name, id, ({ follow = "Lead the way!", come = "On my way.", stay = "I'll stay right here." })[cmd])
				push({ type = "order", name = name, order = cmd, target = id })
			end
			return ok, not ok and msg or nil
		end,
	})
end

core.register_chatcommand("rel", {
	description = "How each character feels about you",
	func = function(name)
		local lines = {}
		for _, id in ipairs(order) do lines[#lines + 1] = meter_line(name, id) end
		return true, #lines > 0 and table.concat(lines, "\n") or "Nobody here yet."
	end,
})

-- The meter of whoever a player looks at, near the crosshair.
local huds = {}
local hud_timer = 0
core.register_globalstep(function(dtime)
	hud_timer = hud_timer + dtime
	if hud_timer < 0.3 then return end
	hud_timer = 0
	for _, player in ipairs(core.get_connected_players()) do
		local pname = player:get_player_name()
		local id = looked_at(player, true)
		local text = id and meter_line(pname, id) or ""
		local h = huds[pname]
		if not h then
			h = { id = player:hud_add({ type = "text", position = { x = 0.5, y = 0.58 },
				text = "", number = 0xFFE8B0, alignment = { x = 0, y = 0 }, scale = { x = 400, y = 40 } }), text = "" }
			huds[pname] = h
		end
		if h.text ~= text then
			player:hud_change(h.id, "text", text)
			h.text = text
		end
	end
end)

core.register_on_leaveplayer(function(player) huds[player:get_player_name()] = nil end)

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
			if type(answer.meters) == "table" then meters = answer.meters end
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
	if message:sub(1, 1) ~= "/" then
		local player = core.get_player_by_name(name)
		push({ type = "chat", name = name, text = line(message), target = player and looked_at(player, false) or nil })
	end
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
