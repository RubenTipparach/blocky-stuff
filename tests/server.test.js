import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.mjs';
import { loadConfig } from '../server/config.mjs';
import { makeApp } from '../server/app.mjs';
import { sign } from '../server/tokens.mjs';
import { createDiscord } from '../server/discord.mjs';
import { managedConfig } from '../server/luanti.mjs';
import { storeMcpToken } from '../server/mcp.mjs';

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
  assert.equal(s.posts[0].body.username, 'alice');
  assert.equal(s.posts[0].body.content, 'hello');
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

test('!link in game whispers a code; !link <code> in Discord joins the two people', async () => {
  const config = loadConfig({ PUBLIC_URL: 'http://localhost', ANTHROPIC_API_KEY: '' });
  const db = openDb(':memory:');
  const posts = [];
  const discord = { post: async (m) => { posts.push(m); return { ok: true }; }, news: async () => ({}), mode: null,
    channelIds: [], setChannels: () => true, start() {}, stop() {} };
  const bot = { ready: true, hear: async () => null };
  const server = makeApp({ config, db, bridgeKey: 'key', discord, bot, log: quiet });
  server.game.sync({ players: [{ name: 'Ruben', pos: { x: 0, y: 0, z: 0 }, hp: 20, privs: [] }] });
  const { actions } = server.game.sync({ events: [{ type: 'chat', name: 'Ruben', text: '!link' }] });
  assert.equal(actions[0].to, 'Ruben');
  const code = /!link (\w{6})/.exec(actions[0].text)[1];
  assert.equal(db.chat(5).length, 0); // the code is never in the public log
  server.discord.post({ text: 'x' });
  await server.fromDiscord({ channelId: '1', userId: '42', name: 'PscifieX', text: `!link ${code.toLowerCase()}` });
  assert.match(posts.at(-1).text, /one and the same/);
  assert.equal(db.person('discord:42').id, 'game:ruben');
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
