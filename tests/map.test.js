import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderIso, colorOf, loadColors } from '../server/map.mjs';
import { openDb } from '../server/db.mjs';
import { loadConfig } from '../server/config.mjs';
import { makeApp } from '../server/app.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeRuns, sampleWorld } from './helpers/fake-scan.js';

const quiet = { log() {}, error() {} };
const PNG = [0x89, 0x50, 0x4e, 0x47];
// A 4 by 4 patch of grass, one stone column, a character standing on it.
const scan = { x1: 0, z1: 0, w: 4, d: 4, y1: 0, names: ['default:dirt_with_grass', 'default:stone'],
  cols: Array.from({ length: 16 }, (_, i) => (i === 5 ? [3, 1, 1, 1] : [1, 0])), marks: [{ id: 'moss', x: 1, y: 3, z: 1 }] };

test('the colours from minetestmapper load, and unknown nodes get a steady colour of their own', () => {
  assert.deepEqual(loadColors().get('default:stone').slice(0, 3), [97, 94, 93]);
  assert.deepEqual(colorOf('mymod:thing'), colorOf('mymod:thing'));
  assert.equal(colorOf('mymod:water_thing')[2] > 100, true);
});

test('the same area draws the same wherever it is in the world', () => {
  const far = { ...scan, x1: -500, z1: 300, marks: [{ id: 'moss', x: -499, y: 3, z: 301 }] };
  assert.deepEqual(renderIso(far).png, renderIso(scan).png);
});

test('an area renders to an isometric PNG', () => {
  const { png, width, height } = renderIso(scan, { markColors: { moss: '#4f7a34' } });
  assert.deepEqual([...png.subarray(0, 4)], PNG);
  assert.ok(width > 0 && height > 0);
  assert.equal(png.readUInt32BE(16), width);
});

test('the public map page, a render on request held to its pace, and /picture taking a picture', async () => {
  const config = loadConfig({ PUBLIC_URL: 'http://localhost', DATA_DIR: mkdtempSync(join(tmpdir(), 'blocky-map-')) });
  const db = openDb(':memory:');
  const pictures = [];
  const discord = { mode: 'bot', channelIds: ['1'], post: async () => ({ ok: true }), news: async () => ({}),
    postImage: async (m) => { pictures.push(m); return { ok: true }; }, setChannels: () => true, start() {}, stop() {} };
  const server = makeApp({ config, db, bridgeKey: 'k', discord, bot: { ready: true, hear: async () => null }, log: quiet });
  const { game } = server;
  // Play the mod: answer every scan from a small world.
  game.sync({ players: [], bodies: [{ id: 'blocky', x: 5, y: 2, z: 5 }] });
  const asked = [];
  const answerScans = setInterval(() => {
    const { actions } = game.sync({});
    asked.push(...actions);
    game.sync({ results: actions.map((a) => ({ id: a.id, ok: true, message: JSON.stringify(a.runs ? fakeRuns(sampleWorld, a) : scan) })) });
  }, 5);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.match(await (await fetch(`${base}/map`)).text(), /what the characters are up to/i);
    const r = await fetch(`${base}/map/render?x=0&z=0&r=8`);
    assert.equal(r.status, 200);
    assert.deepEqual([...new Uint8Array(await r.arrayBuffer()).subarray(0, 4)], PNG);
    assert.equal((await fetch(`${base}/map/render?x=0&z=0`)).status, 429);
    assert.equal((await fetch(`${base}/map/render?x=a`)).status, 400);
    const shot = await server.maps.pictures('blocky');
    assert.equal(shot.pictures.length, 1);
    assert.equal(shot.pictures[0].ch.name, 'Blocky');
    assert.deepEqual([...shot.pictures[0].png.subarray(0, 4)], PNG);
    assert.match((await server.maps.pictures('')).error, /a moment/); // one ask every 30 seconds
    await server.maps.postNow('blocky');
    assert.equal((await fetch(`${base}/map/img/blocky.png`)).status, 200);
    // The tile map: a tile is a PNG, drawn once and kept; where.json says who is where; every post links the map.
    const t = await fetch(`${base}/map/tiles/0/-1.png`);
    assert.equal(t.status, 200);
    assert.deepEqual([...new Uint8Array(await t.arrayBuffer()).subarray(0, 4)], PNG);
    const w = await (await fetch(`${base}/map/where.json`)).json();
    assert.deepEqual(w.characters.map((c) => [c.name, c.x, c.z]), [['Blocky', 5, 5]]);
    assert.match(pictures[0].text, /More maps: http:\/\/localhost\/map/);
    assert.match(await (await fetch(`${base}/map`)).text(), /leaflet/);
    // An isometric chunk of the map, cut at the asked height, in the shared frame (clear background: RGBA).
    const iso = await fetch(`${base}/map/iso/2/-3.png?top=40`);
    assert.equal(iso.status, 200);
    const isoPng = Buffer.from(await iso.arrayBuffer());
    assert.equal(isoPng[25], 6); // colour type 6: RGBA
    // The frame's height is fixed (y -32 to 127), whatever the chunk holds: that is what lines chunks up.
    assert.equal(isoPng.readUInt32BE(20), Math.round(((64 + 64) * 4) / 2 + (127 + 32 + 3) * 4 + 3 * 4));
    assert.match(await (await fetch(`${base}/map?view=flat`)).text(), /tiles/);
    // Everything was drawn from the store: the game was only asked for whole chunks, each once.
    assert.ok(asked.every((a) => a.type === 'scan' && a.runs && a.x1 % 64 === 0 && a.z1 % 64 === 0 && a.w === 64 && a.y1 === -32 && a.y2 === 127));
    const keys = asked.map((a) => `${a.x1},${a.z1}`);
    assert.equal(new Set(keys).size, keys.length);
    const before = asked.length;
    // Another look at the same place: no new scan.
    assert.equal((await fetch(`${base}/map/tiles/0/-1.png`)).status, 200);
    assert.equal(asked.length, before);
  } finally {
    clearInterval(answerScans);
    await new Promise((r) => server.close(r));
  }
});

test('pictures go to Discord only while someone is online, at most every 30 minutes, aimed at the character', async () => {
  const config = loadConfig({ PUBLIC_URL: 'http://localhost', DATA_DIR: mkdtempSync(join(tmpdir(), 'blocky-map-')) });
  const db = openDb(':memory:');
  const pictures = [];
  let clock = Date.parse('2026-10-27T12:00:00Z');
  const discord = { mode: 'bot', channelIds: ['1'], post: async () => ({ ok: true }), news: async () => ({}),
    postImage: async (m) => { pictures.push(m); return { ok: true }; }, setChannels: () => true, start() {}, stop() {} };
  const server = makeApp({ config, db, bridgeKey: 'k', discord, bot: { ready: true, hear: async () => null }, log: quiet,
    now: () => clock });
  const { game } = server;
  const scans = [];
  const answer = setInterval(() => {
    const { actions } = game.sync({});
    for (const a of actions) scans.push(a);
    game.sync({ results: actions.map((a) => ({ id: a.id, ok: true, message: JSON.stringify(fakeRuns(sampleWorld, a)) })) });
  }, 5);
  try {
    game.sync({ players: [], bodies: [{ id: 'blocky', x: 100, y: 7, z: -40 }] });
    await server.maps.tick();
    assert.equal(pictures.length, 0); // nobody online: the page's picture only
    assert.deepEqual([db.json('maps', {}).blocky.x, db.json('maps', {}).blocky.z], [100, -40]); // aimed at her
    assert.ok(scans.some((a) => a.x1 === 64 && a.z1 === -64)); // the chunk she stands in
    game.sync({ players: [{ name: 'alice', pos: { x: 0, y: 0, z: 0 }, hp: 20, privs: [] }], bodies: [{ id: 'blocky', x: 100, y: 7, z: -40 }] });
    await server.maps.tick();
    assert.equal(pictures.length, 1);
    clock += 10 * 60_000;
    game.sync({}); // the mod syncs every second; the jumped clock needs one
    await server.maps.tick();
    assert.equal(pictures.length, 1); // not again within 30 minutes
    clock += 21 * 60_000;
    game.sync({});
    await server.maps.tick();
    assert.equal(pictures.length, 2);
  } finally {
    clearInterval(answer);
  }
});

test('the explored world is read from map.sqlite, in either layout', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdirSync } = await import('node:fs');
  const { createMaps } = await import('../server/maps.mjs');
  const { createGame } = await import('../server/game.mjs');
  for (const layout of ['xyz', 'pos']) {
    const dataDir = mkdtempSync(join(tmpdir(), 'blocky-explored-'));
    mkdirSync(join(dataDir, 'world'));
    const w = new DatabaseSync(join(dataDir, 'world', 'map.sqlite'));
    if (layout === 'xyz') {
      w.exec('CREATE TABLE blocks (x INTEGER, y INTEGER, z INTEGER, data BLOB, PRIMARY KEY (x, z, y))');
      for (const [x, y, z] of [[0, 0, 0], [3, 1, 3], [4, 0, -1], [-5, 2, 8]]) w.prepare("INSERT INTO blocks VALUES (?, ?, ?, x'00')").run(x, y, z);
    } else {
      w.exec('CREATE TABLE blocks (pos INT PRIMARY KEY, data BLOB)');
      const pos = (x, y, z) => z * 16777216 + y * 4096 + x;
      for (const [x, y, z] of [[0, 0, 0], [3, 1, 3], [4, 0, -1], [-5, 2, 8]]) w.prepare("INSERT INTO blocks VALUES (?, x'00')").run(pos(x, y, z));
    }
    w.close();
    const maps = createMaps({ db: openDb(':memory:'), game: createGame(), config: { dataDir, publicUrl: 'http://x', serverName: 'B', gamePort: 1 },
      characters: () => [], chat: {}, log: quiet });
    const res = { writeHead() {}, end(body) { this.body = body; } };
    await maps.handle({ method: 'GET' }, res, new URL('http://x/map/explored.json'), '1');
    const e = JSON.parse(res.body);
    // Map blocks are 16 apart, chunks 64: blocks 0..3 are chunk 0, 4 is chunk 1, -5 is chunk -2, 8 is chunk 2.
    assert.deepEqual(e.chunks.map((c) => c.join(',')).sort(), ['-2,2', '0,0', '1,-1'], layout);
    assert.deepEqual(e.bounds, { cx1: -2, cz1: -1, cx2: 1, cz2: 2 }, layout);
  }
});

test('the map store is brought up to date every 5 minutes, only where something happened', async () => {
  const config = loadConfig({ PUBLIC_URL: 'http://localhost', DATA_DIR: mkdtempSync(join(tmpdir(), 'blocky-map-')) });
  const db = openDb(':memory:');
  let clock = Date.parse('2026-10-27T12:00:00Z');
  const discord = { mode: '', channelIds: [], post: async () => ({ ok: true }), news: async () => ({}), setChannels: () => true, start() {}, stop() {} };
  const server = makeApp({ config, db, bridgeKey: 'k', discord, bot: { ready: true, hear: async () => null }, log: quiet, now: () => clock });
  const { game } = server;
  const scans = [];
  const answer = setInterval(() => {
    const { actions } = game.sync({});
    for (const a of actions) {
      if (a.type === 'scan') scans.push(a);
      game.sync({ results: [{ id: a.id, ok: true, message: a.type === 'scan' ? JSON.stringify(fakeRuns(sampleWorld, a)) : 'Placed.' }] });
    }
  }, 5);
  try {
    game.sync({ players: [] });
    assert.equal(await server.maps.survey(), 0); // nothing happened: nothing read
    await game.act({ type: 'place', nodes: [{ x: 10, y: 9, z: 10, item: 'default:wood' }, { x: 70, y: 9, z: 10, item: 'default:wood' }] });
    assert.equal(await server.maps.survey(), 2); // the two chunks built on
    assert.deepEqual(scans.map((a) => [a.x1, a.z1]).sort(), [[0, 0], [64, 0]]);
    await game.act({ type: 'place', nodes: [{ x: 10, y: 9, z: 10, item: 'default:wood' }] });
    assert.equal(await server.maps.survey(), 0); // within 5 minutes: it waits
    clock += 5 * 60_000;
    game.sync({});
    assert.equal(await server.maps.survey(), 1);
  } finally {
    clearInterval(answer);
  }
});
