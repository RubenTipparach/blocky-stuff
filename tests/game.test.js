import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, checkAction } from '../server/game.mjs';
import { toolsFor, runTool, boxNodes, DEFAULT_POLICY } from '../server/tools.mjs';

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
