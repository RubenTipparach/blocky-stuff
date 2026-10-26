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
		local color = a.from:sub(1, 9) == "[Discord]" and DISCORD_COLOR or BOT_COLOR
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

function actions.kick(a)
	if not core.get_player_by_name(a.player) then return false, tostring(a.player) .. " is not online." end
	core.kick_player(a.player, line(a.reason, 200) ~= "" and line(a.reason, 200) or "Kicked by an admin.")
	return true, "Kicked " .. a.player .. "."
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
