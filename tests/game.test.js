import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, checkAction } from '../server/game.mjs';
import { toolsFor, runTool, boxNodes, roofNodes, DEFAULT_POLICY } from '../server/tools.mjs';

const alice = { name: 'alice', pos: { x: 1.4, y: 2.6, z: -3 }, hp: 20, privs: ['interact', 'shout'] };
const boss = { name: 'Boss', pos: { x: 0, y: 0, z: 0 }, hp: 20, privs: ['server'] };

test('the game is down until the mod syncs, and the players come from the sync', () => {
  const game = createGame();
  assert.equal(game.connected, false);
  game.sync({ players: [alice], time: 0.5, events: [] });
  assert.equal(game.connected, true);
  assert.deepEqual(game.players[0].pos, { x: 1, y: 3, z: -3 });
  assert.equal(game.player('ALICE').name, 'alice');
});

test('an action goes out on the next sync and resolves with the mod\'s result', async () => {
  const game = createGame();
  game.sync({ players: [alice] });
  const done = game.act({ type: 'heal', player: 'alice' });
  const { actions } = game.sync({});
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'heal');
  game.sync({ results: [{ id: actions[0].id, ok: true, message: 'Healed alice.' }] });
  assert.deepEqual(await done, { ok: true, message: 'Healed alice.' });
  assert.equal(game.sync({}).actions.length, 0);
});

test('an action is refused when the game is down or the action is malformed', async () => {
  const game = createGame();
  assert.equal((await game.act({ type: 'heal', player: 'alice' })).ok, false);
  assert.match(checkAction({ type: 'teleport', player: 'a', x: 1, y: 2 }), /needs z/);
  assert.match(checkAction({ type: 'explode' }), /Unknown/);
  assert.equal(checkAction({ type: 'say', text: 'hi' }), null);
});

test('events reach listeners, and the start event carries the item list', () => {
  const game = createGame();
  const seen = [];
  game.onEvent((e) => seen.push(e.type));
  game.sync({ events: [{ type: 'start', items: ['default:dirt', 'default:pick_diamond', 'default:pick_wood'] },
    { type: 'chat', name: 'alice', text: 'hi' }] });
  assert.deepEqual(seen, ['start', 'chat']);
  assert.deepEqual(game.findItems('pick diamond'), ['default:pick_diamond']);
});

test('players get only the tools the policy allows; admins get all', () => {
  const names = (a, p) => toolsFor(a, p).map((t) => t.name);
  const player = names({ name: 'alice', admin: false }, DEFAULT_POLICY);
  assert.ok(player.includes('give_item'));
  assert.ok(!player.includes('fill_box'));
  assert.ok(!player.includes('kick_player'));
  assert.ok(names({ name: 'Boss', admin: true }, DEFAULT_POLICY).includes('kick_player'));
  assert.ok(!names({ name: 'alice', admin: false }, { ...DEFAULT_POLICY, give: false }).includes('give_item'));
});

test('a player may give and teleport only themselves', async () => {
  const game = createGame();
  game.sync({ players: [alice, boss] });
  const asker = { name: 'alice', admin: false };
  const other = await runTool('give_item', { player: 'Boss', item: 'default:dirt' }, { game, asker });
  assert.equal(other.ok, false);
  assert.match(other.message, /themselves/);
  const own = runTool('give_item', { player: 'Alice', item: 'default:dirt', count: 500 }, { game, asker });
  const { actions } = game.sync({});
  assert.equal(actions[0].count, 99);
  game.sync({ results: [{ id: actions[0].id, ok: true, message: 'Gave.' }] });
  assert.equal((await own).ok, true);
  const kick = await runTool('kick_player', { player: 'Boss' }, { game, asker });
  assert.match(kick.message, /may not/);
});

test('a box is its blocks, hollow is its shell, and a box too big is refused', () => {
  assert.equal(boxNodes({ item: 'default:wood', x1: 0, y1: 0, z1: 0, x2: 2, y2: 2, z2: 2 }).length, 27);
  assert.equal(boxNodes({ item: 'default:wood', x1: 2, y1: 2, z1: 2, x2: 0, y2: 0, z2: 0, hollow: true }).length, 26);
  assert.equal(boxNodes({ item: 'default:wood', x1: 0, y1: 0, z1: 0, x2: 19, y2: 19, z2: 19 }), null);
});

test('a character follows, comes to and stays for players who ask, each only for themselves', async () => {
  const game = createGame();
  game.sync({ players: [alice, boss] });
  const asker = { name: 'alice', admin: false };
  assert.match((await runTool('follow_player', { player: 'Boss' }, { game, asker })).message, /themselves/);
  const g = Object.create(game);
  g.act = (a) => game.act({ ...a, by: 'moss' });
  const pending = [runTool('follow_player', { player: 'alice' }, { game: g, asker }), runTool('stay_put', {}, { game: g, asker }),
    runTool('come_to', { player: 'alice' }, { game: g, asker })];
  const { actions } = game.sync({});
  assert.deepEqual(actions.map((a) => [a.type, a.by]), [['follow', 'moss'], ['stay', 'moss'], ['come', 'moss']]);
  game.sync({ results: actions.map((a) => ({ id: a.id, ok: true, message: 'ok' })) });
  assert.ok((await Promise.all(pending)).every((r) => r.ok));
});

test('farm and harvest go to the mod as actions, for those who may build', async () => {
  const game = createGame();
  game.sync({ players: [alice] });
  assert.ok(toolsFor({ name: 'alice', admin: false }, { ...DEFAULT_POLICY, build: true }).some((t) => t.name === 'farm'));
  assert.ok(!toolsFor({ name: 'alice', admin: false }, DEFAULT_POLICY).some((t) => t.name === 'farm'));
  const sowing = runTool('farm', { x1: 0, z1: 0, x2: 8, z2: 5 }, { game, asker: { name: 'Boss', admin: true }, policy: DEFAULT_POLICY });
  const [farm] = game.sync({}).actions;
  assert.deepEqual({ ...farm, id: undefined }, { id: undefined, type: 'farm', x1: 0, z1: 0, x2: 8, z2: 5, crop: 'wheat', water: true });
  game.sync({ results: [{ id: farm.id, ok: true, message: 'Tilled 54, sowed 48 wheat.' }] });
  assert.equal((await sowing).ok, true);
  const reaping = runTool('harvest', { x1: 0, z1: 0, x2: 8, z2: 5, y: 3, player: 'alice' }, { game, asker: { name: 'Boss', admin: true }, policy: DEFAULT_POLICY });
  const [harvest] = game.sync({}).actions;
  assert.equal(checkAction(harvest), null);
  assert.equal(harvest.player, 'alice');
  game.sync({ results: [{ id: harvest.id, ok: true, message: 'Harvested 48.' }] });
  await reaping;
});

test('fill_box goes as one box action (up to 100,000 blocks), and clear_area clears or levels big ground', async () => {
  const game = createGame();
  game.sync({ players: [alice] });
  const ctx = { game, asker: { name: 'Boss', admin: true }, policy: DEFAULT_POLICY };
  assert.equal((await runTool('fill_box', { item: 'default:stone', x1: 0, y1: 0, z1: 0, x2: 100, y2: 100, z2: 100 }, ctx)).ok, false);
  const filling = runTool('fill_box', { item: 'default:stone', x1: 0, y1: 0, z1: 0, x2: 39, y2: 39, z2: 39, hollow: true }, ctx);
  const [box] = game.sync({}).actions;
  assert.deepEqual([box.type, box.hollow, checkAction(box)], ['box', true, null]);
  game.sync({ results: [{ id: box.id, ok: true, message: 'Placed 9128 blocks.' }] });
  await filling;
  const levelling = runTool('clear_area', { x1: 0, z1: 0, x2: 99, z2: 99, mode: 'level', y: 12 }, ctx);
  const [clear] = game.sync({}).actions;
  assert.deepEqual([clear.type, clear.mode, clear.y, checkAction(clear)], ['clear', 'level', 12, null]);
  game.sync({ results: [{ id: clear.id, ok: true, message: 'Levelling 100 by 100 at y 12.' }] });
  await levelling;
});

test('a gable roof rises a course at a time from the eaves to a slab ridge, its ends closed; a hip has four slopes', () => {
  const gable = roofNodes({ x1: 0, z1: 0, x2: 6, z2: 4, y: 5, stairs: 'stairs:stair_pine_wood' });
  const at = (n, x, y, z) => n.find((b) => b.x === x && b.y === y && b.z === z);
  assert.deepEqual([at(gable, 3, 5, -1).facing, at(gable, 3, 5, 5).facing], ['north', 'south']); // eaves, one out
  assert.deepEqual([at(gable, 3, 6, 0).facing, at(gable, 3, 7, 1).facing], ['north', 'north']);
  assert.equal(at(gable, 3, 8, 2).item, 'stairs:slab_pine_wood'); // the ridge
  assert.equal(at(gable, 0, 6, 2).item, 'default:pine_wood'); // the gable end
  assert.equal(at(gable, 3, 6, 2), undefined); // the attic stays open
  const hip = roofNodes({ x1: 0, z1: 0, x2: 4, z2: 4, y: 5, style: 'hip', stairs: 'stairs:stair_wood', overhang: 0 });
  assert.deepEqual([at(hip, 0, 5, 2).facing, at(hip, 4, 5, 2).facing], ['east', 'west']);
  assert.equal(at(hip, 2, 7, 2).item, 'stairs:slab_wood'); // the point
});

test('every roof shape: steep courses stand on full blocks, a cone and a dome are round, a castle has merlons', () => {
  const at = (n, x, y, z) => n.find((b) => b.x === x && b.y === y && b.z === z);
  const base = { x1: 0, z1: 0, x2: 8, z2: 8, y: 5, stairs: 'stairs:stair_stonebrick' };
  for (const style of ['gable', 'hip', 'pyramid', 'shed', 'gambrel', 'dome', 'cone', 'castle', 'flat']) {
    const n = roofNodes({ ...base, style });
    assert.ok(n.length > 20, style);
    assert.equal(new Set(n.map((b) => `${b.x},${b.y},${b.z}`)).size, n.length, `${style}: no block twice`);
  }
  const steep = roofNodes({ ...base, style: 'gable', ridge_along: 'x', pitch: 'steep' });
  assert.deepEqual([at(steep, 4, 5, -1).item, at(steep, 4, 6, -1).facing], ['default:stonebrick', 'north']);
  const gambrel = roofNodes({ ...base, style: 'gambrel', ridge_along: 'x' });
  // Steep below (a full block under the eave), shallow above: lower than a steep gable, higher than a plain one.
  const top = (n) => Math.max(...n.map((b) => b.y));
  assert.equal(at(gambrel, 4, 5, -1).item, 'default:stonebrick');
  assert.ok(top(gambrel) < top(steep) && top(gambrel) > top(roofNodes({ ...base, style: 'gable', ridge_along: 'x' })));
  const cone = roofNodes({ ...base, style: 'cone' });
  assert.equal(at(cone, -1, 5, -1), undefined); // round: the corners stay open
  const dome = roofNodes({ ...base, style: 'dome', block: 'default:sandstonebrick' });
  assert.equal(at(dome, 4, 6, 4), undefined); // hollow
  assert.ok(dome.every((b) => b.item === 'default:sandstonebrick'));
  const castle = roofNodes({ ...base, style: 'castle' });
  assert.deepEqual([!!at(castle, 0, 7, 0), !!at(castle, 1, 7, 0), !!at(castle, 2, 7, 0)], [true, false, true]); // merlons
});
