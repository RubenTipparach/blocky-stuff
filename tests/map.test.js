import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderIso, colorOf, loadColors } from '../server/map.mjs';
import { openDb } from '../server/db.mjs';
import { loadConfig } from '../server/config.mjs';
import { makeApp } from '../server/app.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('the public map page, a render on request held to its pace, and !map posting a picture', async () => {
  const config = loadConfig({ PUBLIC_URL: 'http://localhost', DATA_DIR: mkdtempSync(join(tmpdir(), 'blocky-map-')) });
  const db = openDb(':memory:');
  const pictures = [];
  const discord = { mode: 'bot', channelIds: ['1'], post: async () => ({ ok: true }), news: async () => ({}),
    postImage: async (m) => { pictures.push(m); return { ok: true }; }, setChannels: () => true, start() {}, stop() {} };
  const server = makeApp({ config, db, bridgeKey: 'k', discord, bot: { ready: true, hear: async () => null }, log: quiet });
  const { game } = server;
  // Play the mod: answer every scan with the patch above.
  game.sync({ players: [], bodies: [{ id: 'blocky', x: 5, y: 2, z: 5 }] });
  const answerScans = setInterval(() => {
    const { actions } = game.sync({});
    game.sync({ results: actions.map((a) => ({ id: a.id, ok: true, message: JSON.stringify(scan) })) });
  }, 5);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.match(await (await fetch(`${base}/map`)).text(), /what the characters are up to/);
    const r = await fetch(`${base}/map/render?x=0&z=0&r=8`);
    assert.equal(r.status, 200);
    assert.deepEqual([...new Uint8Array(await r.arrayBuffer()).subarray(0, 4)], PNG);
    assert.equal((await fetch(`${base}/map/render?x=0&z=0`)).status, 429);
    assert.equal((await fetch(`${base}/map/render?x=a`)).status, 400);
    await server.maps.command('!map blocky');
    assert.equal(pictures.length, 1);
    assert.equal(pictures[0].as, 'Blocky');
    assert.deepEqual([...pictures[0].png.subarray(0, 4)], PNG);
    assert.equal((await fetch(`${base}/map/img/blocky.png`)).status, 200);
  } finally {
    clearInterval(answerScans);
    await new Promise((r) => server.close(r));
  }
});
