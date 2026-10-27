import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.mjs';
import { loadConfig } from '../server/config.mjs';
import { makeApp } from '../server/app.mjs';
import { sign } from '../server/tokens.mjs';
import { createDiscord } from '../server/discord.mjs';
import { managedConfig } from '../server/luanti.mjs';
import { storeMcpToken, mcpCall } from '../server/mcp.mjs';
import { cast } from '../server/character.mjs';

const quiet = { log() {}, error() {} };

async function start(env = {}) {
  const config = loadConfig({ PUBLIC_URL: 'http://localhost', ADMIN_DISCORD_ID: '111', ANTHROPIC_API_KEY: '', ...env });
  const db = openDb(':memory:');
  const posts = [];
  const discord = createDiscord({ webhookUrls: ['https://discord.com/api/webhooks/12345/abc'], log: quiet,
    fetchImpl: async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; } });
  const server = makeApp({ config, db, bridgeKey: 'key', discord, log: quiet });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const secret = db.secret('session');
  const as = (sub) => ({ authorization: `Bearer ${sign({ kind: 'session', sub, name: 'n' }, secret)}` });
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await res.text();
    let json = null;
    try { json = JSON.parse(t); } catch { /* text */ }
    return { status: res.status, json, text: t };
  };
  return { server, db, call, as, posts, close: () => new Promise((r) => server.close(r)) };
}

test('health answers, and / leads to the admin page', async () => {
  const s = await start();
  assert.equal((await s.call('/health')).text, 'ok');
  assert.match((await s.call('/admin')).text, /Blocky Stuff admin/);
  await s.close();
});

test('the bridge takes the mod\'s key only, and relays chat to Discord', async () => {
  const s = await start();
  assert.equal((await s.call('/bridge/sync', { method: 'POST', body: {}, headers: { 'x-bridge-key': 'wrong' } })).status, 403);
  const r = await s.call('/bridge/sync', { method: 'POST', headers: { 'x-bridge-key': 'key' },
    body: { players: [], events: [{ type: 'chat', name: 'alice', text: 'hello' }] } });
  assert.equal(r.status, 200);
  // Every line gets an answer: here, with no API key, the characters say they are not plugged in.
  assert.match(r.json.actions[0].text, /not plugged in/);
  assert.equal(r.json.bot, 'Blocky');
  assert.deepEqual(r.json.characters.map((c) => c.name), ['Blocky', 'Moss']);
  assert.ok(s.db.chat(5).some((c) => c.source === 'game' && c.text === 'hello'));
  await new Promise((done) => setTimeout(done, 20));
  // A player's line goes as a small embed: their name over a stripe of their own colour.
  assert.equal(s.posts[0].body.username, 'alice');
  assert.equal(s.posts[0].body.embeds[0].author.name, 'alice');
  assert.equal(s.posts[0].body.embeds[0].description, 'hello');
  const first = s.posts[0].body.embeds[0].color;
  assert.equal(first, parseInt(s.db.colorOf('game:alice').slice(1), 16));
  // The same person keeps the same colour; an admin's pick wins.
  s.db.setColor('game:alice', '#123456');
  assert.equal(s.db.colorOf('game:alice'), '#123456');
  await s.close();
});

test('the admin API wants a signed-in admin', async () => {
  const s = await start();
  assert.equal((await s.call('/api/admin')).status, 401);
  const not = await s.call('/api/admin', { headers: s.as('222') });
  assert.equal(not.status, 403);
  assert.equal(not.json.you.id, '222');
  const ok = await s.call('/api/admin', { headers: s.as('111') });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.bot.ready, false);
  assert.deepEqual(ok.json.missing.bot, ['ANTHROPIC_API_KEY']);
  await s.close();
});

test('bot settings save, and nonsense in them is ignored', async () => {
  const s = await start();
  const r = await s.call('/api/admin/bot', { method: 'POST', headers: s.as('111'),
    body: { effort: 'silly', cooldown: -3, policy: { build: true, give: 'yes' } } });
  assert.equal(r.json.settings.effort, 'low');
  assert.equal(r.json.settings.cooldown, 2);
  assert.equal(r.json.settings.policy.build, true);
  assert.equal(r.json.settings.policy.give, true);
  await s.close();
});

test('an announcement goes to the game on its next sync', async () => {
  const s = await start();
  await s.call('/bridge/sync', { method: 'POST', headers: { 'x-bridge-key': 'key' }, body: {} });
  const said = s.call('/api/admin/announce', { method: 'POST', headers: s.as('111'), body: { text: 'Restart in 5' } });
  await new Promise((r) => setTimeout(r, 30));
  const { json } = await s.call('/bridge/sync', { method: 'POST', headers: { 'x-bridge-key': 'key' }, body: {} });
  assert.equal(json.actions[0].type, 'say');
  assert.equal(json.actions[0].from, 'Server');
  await s.call('/bridge/sync', { method: 'POST', headers: { 'x-bridge-key': 'key' },
    body: { results: [{ id: json.actions[0].id, ok: true, message: 'Said.' }] } });
  assert.equal((await said).json.ok, true);
  await s.close();
});

test('MCP wants its token, then lists and runs tools', async () => {
  const s = await start();
  const rpc = (body, token = 'blk_test') => s.call('/mcp', { method: 'POST', body, headers: { authorization: `Bearer ${token}` } });
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' })).status, 401);
  storeMcpToken(s.db, 'blk_test');
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.json.result.protocolVersion, '2025-06-18');
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = list.json.result.tools.map((t) => t.name);
  assert.ok(names.includes('kick_player') && names.includes('announce') && names.includes('recent_chat'));
  const status = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'server_status', arguments: {} } });
  assert.equal(JSON.parse(status.json.result.content[0].text).server.connected, false);
  const down = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'heal_player', arguments: { player: 'a' } } });
  assert.equal(down.json.result.isError, true);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 5, method: 'nope' })).json.error.code, -32601);
  await s.close();
});

test('MCP_TOKEN works without one made on /admin', async () => {
  const s = await start({ MCP_TOKEN: 'from-fly' });
  const r = await s.call('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'ping' }, headers: { authorization: 'Bearer from-fly' } });
  assert.deepEqual(r.json.result, {});
  await s.close();
});

test('Luanti\'s config gets the bridge, the bind address and the admin', () => {
  const conf = managedConfig({ config: loadConfig({ GAME_ADMIN: 'ruben', SERVER_NAME: 'Blocky\nStuff' }), bindAddress: '1.2.3.4', bridgeKey: 'k' });
  assert.match(conf, /^bind_address = 1\.2\.3\.4$/m);
  assert.match(conf, /^secure\.http_mods = ai_bot$/m);
  assert.match(conf, /^ai_bot\.bridge_key = k$/m);
  // Luanti's HTTP leaves from the bound address, so the mod calls the sidecar there.
  assert.match(conf, /^ai_bot\.bridge_url = http:\/\/1\.2\.3\.4:8080\/bridge\/sync$/m);
  assert.match(managedConfig({ config: loadConfig({}), bindAddress: '', bridgeKey: 'k' }), /^ai_bot\.bridge_url = http:\/\/127\.0\.0\.1:8080/m);
  assert.match(conf, /^name = ruben$/m);
  assert.match(conf, /^server_name = Blocky Stuff$/m);
});

test('Discord: the bot wins over webhooks, posts never ping, and bad channel ids are refused', async () => {
  const sent = [];
  const d = createDiscord({ token: 'tok', channelIds: ['123456'], webhookUrls: ['https://discord.com/api/webhooks/1/x'], log: quiet,
    fetchImpl: async (url, init) => { sent.push({ url, init }); return { ok: true }; } });
  assert.equal(d.mode, 'bot');
  await d.post({ text: 'hi @everyone', as: 'alice' });
  assert.equal(sent[0].url, 'https://discord.com/api/v10/channels/123456/messages');
  const body = JSON.parse(sent[0].init.body);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.equal(body.content, '**alice**: hi @everyone');
  assert.equal(d.setChannels(['nope']), false);
  assert.equal(createDiscord({ log: quiet }).mode, null);
});

test('the bot answers any chat by default, and its body walks to whoever it answers', async () => {
  const config = loadConfig({ PUBLIC_URL: 'http://localhost', ANTHROPIC_API_KEY: '' });
  const db = openDb(':memory:');
  const heard = [];
  const bot = { ready: true, hear: async (msg, reply) => { heard.push(msg); await reply('Hi there!'); return 'Hi there!'; } };
  const discord = createDiscord({ log: quiet });
  const server = makeApp({ config, db, bridgeKey: 'key', discord, bot, log: quiet });
  server.game.sync({ players: [{ name: 'alice', pos: { x: 0, y: 0, z: 0 }, hp: 20, privs: [] }] });
  // The stand-in answers at once, so the answer rides out on the very sync that brought the chat.
  const { actions } = server.game.sync({ events: [{ type: 'chat', name: 'alice', text: 'hello' }] });
  assert.equal(heard[0].text, 'hello');
  assert.deepEqual([actions[0].type, actions[0].near, actions[0].text], ['say', 'alice', 'Hi there!']);
});

test('/link in the game whispers a code; /link with it in Discord joins the two people', async () => {
  const config = loadConfig({ PUBLIC_URL: 'http://localhost', ANTHROPIC_API_KEY: '' });
  const db = openDb(':memory:');
  const discord = { post: async () => ({ ok: true }), news: async () => ({}), mode: null,
    channelIds: [], setChannels: () => true, start() {}, stop() {} };
  const bot = { ready: true, hear: async () => null };
  const server = makeApp({ config, db, bridgeKey: 'key', discord, bot, log: quiet });
  server.game.sync({ players: [{ name: 'Ruben', pos: { x: 0, y: 0, z: 0 }, hp: 20, privs: [] }] });
  // The mod sends a linkcode event for /link in the game.
  const { actions } = server.game.sync({ events: [{ type: 'linkcode', name: 'Ruben' }] });
  assert.equal(actions[0].to, 'Ruben');
  const code = /\/link code:(\w{6})/.exec(actions[0].text)[1];
  assert.equal(db.chat(5).length, 0); // the code is never in the public log
  const replies = [];
  await server.slash({ name: 'link', options: { code: code.toLowerCase() }, userId: '42', userName: 'PscifieX',
    reply: async (t, o) => replies.push([t, o]) });
  assert.match(replies[0][0], /one and the same/);
  assert.equal(replies[0][1].ephemeral, true);
  assert.equal(db.person('discord:42').id, 'game:ruben');
  await server.slash({ name: 'link', options: { code: 'ZZZZZZ' }, userId: '43', userName: 'x', reply: async (t) => replies.push([t]) });
  assert.match(replies[1][0], /not one I gave out/);
});

test('an admin can link two people on the admin page', async () => {
  const s = await start();
  s.db.meet('game:ruben', 'Ruben');
  s.db.meet('discord:42', 'PscifieX');
  const r = await s.call('/api/admin/link', { method: 'POST', headers: s.as('111'), body: { keep: 'game:ruben', other: 'discord:42' } });
  assert.equal(r.json.person.id, 'game:ruben');
  assert.equal(s.db.person('discord:42').id, 'game:ruben');
  assert.equal((await s.call('/api/admin/link', { method: 'POST', headers: s.as('111'), body: { keep: 'game:ruben', other: 'discord:42' } })).status, 400);
  assert.equal((await s.call('/api/admin/link', { method: 'POST', headers: s.as('222'), body: { keep: 'a', other: 'b' } })).status, 403);
  await s.close();
});

test('characters are renamed, added and removed on the admin page; the last one stays', async () => {
  const s = await start();
  const post = (body) => s.call('/api/admin/character', { method: 'POST', headers: s.as('111'), body });
  assert.equal((await post({ id: 'blocky', name: 'Pebble', dressColor: '#ff0000', chatColor: 'red' })).json.character.name, 'Pebble');
  const added = (await post({ id: '', name: 'Wren' })).json.character;
  assert.equal(added.id, 'wren');
  assert.equal(added.pronouns, 'she/her');
  const all = (await s.call('/api/admin', { headers: s.as('111') })).json.characters;
  assert.deepEqual(all.map((c) => c.name), ['Pebble', 'Moss', 'Wren']);
  assert.equal(all[0].dressColor, '#ff0000');
  assert.equal(all[0].chatColor, '#f2b84b');
  assert.equal((await post({ id: 'moss', remove: true })).status, 200);
  assert.equal((await post({ id: 'wren', remove: true })).status, 200);
  assert.equal((await post({ id: 'blocky', remove: true })).status, 400);
  assert.equal((await post({ id: '', name: '!' })).status, 400);
  await s.close();
});

test('an admin can link a Discord user to a game name typed in, before that player has joined', async () => {
  const s = await start();
  s.db.meet('discord:77', 'SudoStonk');
  const r = await s.call('/api/admin/link', { method: 'POST', headers: s.as('111'), body: { keep: 'discord:77', gameName: 'sudo' } });
  assert.equal(r.status, 200);
  assert.equal(s.db.person('game:sudo').id, 'discord:77');
  await s.close();
});

test('every game server account is listed, saying who on Discord it is linked to', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dataDir = mkdtempSync(join(tmpdir(), 'blocky-auth-'));
  mkdirSync(join(dataDir, 'world'));
  const auth = new DatabaseSync(join(dataDir, 'world', 'auth.sqlite'));
  auth.exec("CREATE TABLE auth (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, password TEXT NOT NULL, last_login INTEGER NOT NULL DEFAULT 0)");
  for (const [n, t] of [['ruben', 200], ['sudo', 100], ['alice', 50]]) auth.prepare("INSERT INTO auth (name, password, last_login) VALUES (?, 'secret', ?)").run(n, t);
  auth.close();
  const s = await start({ DATA_DIR: dataDir });
  s.db.meet('game:ruben', 'ruben');
  s.db.meet('discord:42', 'PscifieX');
  s.db.link('discord:42', 'game:ruben');
  const r = await s.call('/api/admin', { headers: s.as('111') });
  assert.deepEqual(r.json.gameAccounts.map((a) => [a.name, a.linkedTo]), [['ruben', 'PscifieX'], ['sudo', null], ['alice', null]]);
  assert.ok(!JSON.stringify(r.json.gameAccounts).includes('secret'));
  await s.close();
});

test('asleep once nobody has been around for the delay; switching sleep off, or a word on Discord, wakes them', async () => {
  const config = loadConfig({ PUBLIC_URL: 'http://localhost', ADMIN_DISCORD_ID: '111', ANTHROPIC_API_KEY: '' });
  const db = openDb(':memory:');
  db.putSetting('activity.last', '1'); // the last word from a player: long ago
  let turns = 0;
  const bot = { ready: true, hear: async () => null, idle: async () => { turns++; return null; } };
  const discord = createDiscord({ log: quiet });
  const server = makeApp({ config, db, bridgeKey: 'key', discord, bot, log: quiet });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = { authorization: `Bearer ${sign({ kind: 'session', sub: '111', name: 'n' }, db.secret('session'))}`, 'content-type': 'application/json' };
  try {
    const sync = async () => (await fetch(`${base}/bridge/sync`, { method: 'POST', headers: { 'x-bridge-key': 'key' },
      body: JSON.stringify({ players: [] }) })).json();
    db.putJson('bot', { sleep: true }); // off by default; on here
    await sync();
    await server.idleTick();
    assert.equal(turns, 0); // asleep: nobody in the game
    assert.equal((await sync()).characters.every((c) => c.asleep), true);
    await fetch(`${base}/api/admin/bot`, { method: 'POST', headers: as, body: JSON.stringify({ sleep: false }) });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(turns, 1); // woken at once
    assert.equal((await sync()).characters.some((c) => c.asleep), false);
    // Sleep on again, with the default hour: a player's word on Discord keeps them up.
    await fetch(`${base}/api/admin/bot`, { method: 'POST', headers: as, body: JSON.stringify({ sleep: true }) });
    assert.equal((await sync()).characters.every((c) => c.asleep), true);
    server.fromDiscord({ name: 'ruben', text: 'evening all' });
    assert.equal((await sync()).characters.some((c) => c.asleep), false);
    await fetch(`${base}/api/admin/bot`, { method: 'POST', headers: as, body: JSON.stringify({ sleepAfter: 1 }) });
    assert.equal(db.json('bot', {}).sleepAfter, 5); // at least 5 minutes
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('/help is a guide: how to join, the characters, every command, seen only by the asker', async () => {
  const s = await start({ GAME_ADDRESS: '1.2.3.4' });
  const replies = [];
  await s.server.slash({ name: 'help', options: {}, userId: '42', userName: 'x', reply: async (t, o) => replies.push(o) });
  const { embed, ephemeral } = replies[0];
  assert.equal(ephemeral, true);
  const text = JSON.stringify(embed);
  for (const want of ['luanti.org', '1.2.3.4', '30000', 'Blocky', 'Moss', '/picture', '/link', '/talk', '/rel', '/map']) assert.ok(text.includes(want), want);
  await s.close();
});

test('Discord: plain messages are heard, and on reconnecting the bot catches up on what was said while it was down', async () => {
  const CH = '1553044846057361581';
  class FakeWS { constructor() { FakeWS.last = this; setTimeout(() => this.emit({ op: 10, d: { heartbeat_interval: 40000 } }), 2); }
    emit(m) { this.onmessage?.({ data: JSON.stringify(m) }); } send() {} close() {} }
  const seen = new Map([[CH, '100']]);
  const heard = [];
  const t0 = Date.parse('2026-10-27T08:20:00Z');
  const d = createDiscord({ token: 'T', channelIds: [CH], log: quiet, WebSocketImpl: FakeWS, onMessage: (m) => heard.push(m.text), now: () => t0,
    lastSeen: { get: (c) => seen.get(c), set: (c, id) => seen.set(c, id) },
    fetchImpl: async (url) => ({ ok: true, status: 200, json: async () => (String(url).includes(`/channels/${CH}/messages?after=100`)
      // Newest first, as Discord sends them: one from during the restart, one from long ago.
      ? [{ id: '102', author: { id: '42', username: 'r' }, content: 'are you there?', timestamp: '2026-10-27T08:19:30Z' },
        { id: '101', author: { id: '42', username: 'r' }, content: 'old news', timestamp: '2026-10-27T07:00:00Z' }]
      : String(url).includes('/gateway/bot') ? { url: 'wss://x' } : []) }) });
  d.start();
  await new Promise((r) => setTimeout(r, 20));
  FakeWS.last.emit({ op: 0, s: 1, t: 'READY', d: { user: { id: '999', username: 'luni-bot' }, guilds: [] } });
  await new Promise((r) => setTimeout(r, 20));
  FakeWS.last.emit({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: { id: '103', channel_id: CH, author: { id: '42', username: 'r' }, content: 'Test. can you guys hear me?' } });
  d.stop();
  assert.deepEqual(heard, ['are you there?', 'Test. can you guys hear me?']);
  assert.equal(seen.get(CH), '103');
});

test('once, an old "mentions only" setting becomes "every message"; after that the admin\'s choice stands', async () => {
  const config = loadConfig({ PUBLIC_URL: 'http://localhost' });
  const db = openDb(':memory:');
  db.putJson('bot', { listen: 'mentions', cooldown: 5 });
  makeApp({ config, db, bridgeKey: 'k', discord: createDiscord({ log: quiet }), log: quiet });
  assert.deepEqual(db.json('bot', {}), { listen: 'all', cooldown: 5 });
  db.putJson('bot', { listen: 'mentions' });
  makeApp({ config, db, bridgeKey: 'k', discord: createDiscord({ log: quiet }), log: quiet });
  assert.equal(db.json('bot', {}).listen, 'mentions');
});

test('activity is kept and pages back; MCP tools search it, the chat and a character', async () => {
  const db = openDb(':memory:');
  for (let i = 0; i < 120; i++) db.addActivity({ at: 1000 + i, kind: i % 3 ? 'answered' : 'skipped', character: i % 2 ? 'Moss' : 'Blocky', who: 'ruben', text: `"line ${i}" -> ok` });
  const first = db.activity({ limit: 40 });
  assert.equal(first[0].text, '"line 119" -> ok');
  const next = db.activity({ before: first.at(-1).id, limit: 40 });
  assert.equal(next[0].id, first.at(-1).id - 1);
  assert.equal(db.activity({ kinds: ['skipped'], limit: 500 }).length, 40);
  db.addChat('discord', 'ruben', 'Moss can you clear the pines?', 5);
  db.addChat('bot', 'Moss', 'No axe, sorry.', 6);
  const call = (name, args = {}) => mcpCall({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { db, game: null });
  assert.match((await call('search_chat', { words: 'clear pines' })).result.content[0].text, /Moss can you clear/);
  assert.match((await call('activity_log', { kind: 'skipped', limit: 2 })).result.content[0].text, /\[skipped\]/);
  const summary = JSON.parse((await call('activity_summary', { hours: 720 })).result.content[0].text);
  assert.ok(summary.hours === 720 && 'characters' in summary);
  cast(db);
  assert.match((await call('character_state', { name: 'moss' })).result.content[0].text, /"name": "Moss"/);
});

test('the game\'s items survive a bot restart (the mod sends them only when Luanti starts)', async () => {
  const config = loadConfig({ PUBLIC_URL: 'http://localhost' });
  const db = openDb(':memory:');
  const first = makeApp({ config, db, bridgeKey: 'k', discord: createDiscord({ log: quiet }), log: quiet });
  first.game.sync({ players: [], events: [{ type: 'start', items: ['default:wood', 'doors:door_wood', 'farming:seed_wheat'] }] });
  const again = makeApp({ config, db, bridgeKey: 'k', discord: createDiscord({ log: quiet }), log: quiet });
  assert.deepEqual(again.game.findItems('door'), ['doors:door_wood']);
});

test('MCP: settings read and changed (only what is named), and a stopped task taken up again', async () => {
  const config = loadConfig({ PUBLIC_URL: 'http://localhost', MCP_TOKEN: 'tok' });
  const db = openDb(':memory:');
  const server = makeApp({ config, db, bridgeKey: 'k', discord: createDiscord({ log: quiet }), log: quiet });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (name, args) => (await (await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result.content[0].text;
  try {
    assert.equal(JSON.parse(await call('bot_settings', {})).taskRounds, 150);
    const after = JSON.parse(await call('bot_settings', { set: { taskRounds: 300, idle: { social: 10 } } }));
    assert.deepEqual([after.taskRounds, after.idle.social, after.idle.after], [300, 10, 300]); // the rest of idle kept
    assert.match(await call('resume_task', { name: 'Blocky' }), /no stopped task/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
