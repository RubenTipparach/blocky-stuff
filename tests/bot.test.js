import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.mjs';
import { createGame } from '../server/game.mjs';
import { createBot, finalText } from '../server/bot.mjs';
import { loadConfig } from '../server/config.mjs';

const quiet = { log() {}, error() {} };

// A stand-in for the Anthropic client: answers from a script, and remembers what it was asked.
function fakeClient(script) {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: async (req) => { calls.push(structuredClone(req)); return script.shift()(req); } } },
  };
}
const text = (t) => () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }], usage: { input_tokens: 10, output_tokens: 5 } });

function setup(script, { t = 0 } = {}) {
  const db = openDb(':memory:');
  const game = createGame();
  const config = loadConfig({ ANTHROPIC_API_KEY: 'k' });
  const client = fakeClient(script);
  let clock = t;
  const bot = createBot({ db, game, config, client, now: () => clock, log: quiet });
  return { db, game, bot, client, tick: (ms) => { clock += ms; } };
}

test('the bot hears its name, @name and !ai, and nothing else', () => {
  const { bot } = setup([]);
  for (const t of ['@Blocky hi', 'blocky, how do I craft a pick?', 'hey Blocky', '!ai what time is it']) {
    assert.equal(bot.addressed(t, 'Blocky'), true, t);
  }
  for (const t of ['blockyness', 'hello all', 'ai is cool']) assert.equal(bot.addressed(t, 'Blocky'), false, t);
});

test('a question gets an answer, with the chat and who is online as context', async () => {
  const { db, game, bot, client } = setup([text('Use **three** sticks\nand two planks.')]);
  game.sync({ players: [{ name: 'alice', pos: { x: 1, y: 2, z: 3 }, hp: 20, privs: [] }] });
  db.addChat('game', 'bob', 'nice house');
  const said = [];
  const answer = await bot.hear({ source: 'game', name: 'alice', text: '@Blocky how do I make a pick?' }, (t) => said.push(t));
  assert.equal(answer, 'Use three sticks and two planks.');
  assert.deepEqual(said, [answer]);
  const req = client.calls[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.deepEqual(req.fallbacks, 'default');
  assert.match(req.messages[0].content, /bob: nice house/);
  assert.match(req.messages[0].content, /alice at \(1, 2, 3\)/);
  assert.equal(db.usage(1)[0].calls, 1);
});

test('a tool call runs in the game and its result goes back to the model', async () => {
  const { game, bot, client } = setup([
    () => ({ stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', id: 't1', name: 'heal_player', input: { player: 'alice' } }] }),
    text('There you go!'),
  ]);
  game.sync({ players: [{ name: 'alice', pos: { x: 0, y: 0, z: 0 }, hp: 3, privs: [] }] });
  const pending = bot.hear({ source: 'game', name: 'alice', text: '@blocky heal me' }, () => {});
  // Let the bot reach the tool, then play the mod's part.
  await new Promise((r) => setTimeout(r, 10));
  const { actions } = game.sync({});
  assert.equal(actions[0].type, 'heal');
  game.sync({ results: [{ id: actions[0].id, ok: true, message: 'Healed alice.' }] });
  assert.equal(await pending, 'There you go!');
  const back = client.calls[1].messages[2].content[0];
  assert.deepEqual(back, { type: 'tool_result', tool_use_id: 't1', content: 'Healed alice.' });
});

test('a Discord user gets admin tools only when the caller vouches for them', async () => {
  const { bot, client } = setup([text('Hi!'), text('Building.')]);
  await bot.hear({ source: 'discord', name: 'Boss', text: '@Blocky kick alice' }, () => {});
  assert.ok(!client.calls[0].tools.some((t) => t.name === 'kick_player' || t.name === 'fill_box'));
  await bot.hear({ source: 'discord', name: 'Ruben', text: '@Blocky build a hut', admin: true }, () => {});
  assert.ok(client.calls[1].tools.some((t) => t.name === 'fill_box'));
});

test('a quick second question waits its turn instead of being dropped, and the hourly limit is said', async () => {
  const { db, bot } = setup([text('one'), text('two')]);
  db.putJson('bot', { perHour: 2, cooldown: 0.05 });
  const said = [];
  const ask = () => bot.hear({ source: 'game', name: 'alice', text: '!ai hi' }, (t) => said.push(t));
  assert.equal(await ask(), 'one');
  assert.equal(await ask(), 'two');
  assert.match(await ask(), /a lot this hour/);
  assert.equal(said.length, 3);
});

test('a refusal is answered kindly, and a switched-off bot stays quiet', async () => {
  const { db, bot } = setup([() => ({ stop_reason: 'refusal', content: [], usage: {} })]);
  assert.match(await bot.hear({ source: 'game', name: 'a', text: '!ai x' }, () => {}), /can't help/);
  db.putJson('bot', { enabled: false });
  assert.equal(await bot.hear({ source: 'game', name: 'b', text: '!ai x' }, () => {}), null);
});

test('without an API key the bot says so instead of failing', async () => {
  const db = openDb(':memory:');
  const bot = createBot({ db, game: createGame(), config: loadConfig({}), log: quiet });
  assert.equal(bot.ready, false);
  assert.match(await bot.hear({ source: 'game', name: 'a', text: '!ai hi' }, () => {}), /ANTHROPIC_API_KEY/);
});

test('the reply is one chat line, cut to length', () => {
  assert.equal(finalText([{ type: 'thinking', thinking: '' }, { type: 'text', text: '# Hi\n- there' }]), 'Hi - there');
  assert.ok(finalText([{ type: 'text', text: 'x'.repeat(1000) }]).length <= 450);
  assert.equal(finalText([]), null);
});

test('every line from a person gets an answer, from the character they talk with; characters may stay quiet', async () => {
  const { db, bot } = setup([text('Hi there!'), text('Aye.'), text('Still me.'), text('QUIET'), text('Hello!')]);
  db.putJson('bot', { cooldown: 0 });
  const who = [];
  const hear = (text, extra = {}) => bot.hear({ source: 'game', name: 'alice', text, ...extra }, (t, ch) => who.push([ch.name, t]));
  assert.equal(await hear('lol'), 'Hi there!'); // no name: the first character answers
  assert.equal(await hear('Moss, how deep is the cave?'), 'Aye.');
  assert.equal(await hear('and the diamonds?'), 'Still me.'); // she keeps talking with Moss
  assert.deepEqual(who.map(([n]) => n), ['Blocky', 'Moss', 'Moss']);
  // A character speaking to another may be met with silence.
  assert.equal(await bot.hear({ source: 'character', name: 'Blocky', text: 'Moss, you grump!', personId: 'char:blocky',
    only: 'moss' }, () => {}), null);
  db.putJson('bot', { cooldown: 0, listen: 'mentions' });
  assert.equal(await hear('hello all'), null);
  assert.equal(await hear('@Blocky hello'), 'Hello!');
});

test('a character naming another may get an answer, but not forever', () => {
  const { bot } = setup([]);
  const [blocky, moss] = bot.cast();
  assert.deepEqual(bot.answerers('Moss, look at this!', blocky).map((c) => c.id), ['moss']);
  assert.deepEqual(bot.answerers('Moss, look at this!', blocky, 2), []);
  assert.deepEqual(bot.answerers('I talk about myself, Moss', moss), []);
});

test('what the bot does is kept, and the daily summary tells of it', async () => {
  const { db, game, bot, client } = setup([
    () => ({ stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', id: 't1', name: 'heal_player', input: { player: 'alice' } }] }),
    text('Healed!'),
    text('Today I patched up alice.'),
  ], { t: 1000 });
  game.sync({ players: [{ name: 'alice', pos: { x: 0, y: 0, z: 0 }, hp: 3, privs: [] }] });
  const pending = bot.hear({ source: 'game', name: 'alice', text: '@blocky heal me' }, () => {});
  await new Promise((r) => setTimeout(r, 10));
  const { actions } = game.sync({});
  game.sync({ results: [{ id: actions[0].id, ok: true, message: 'Healed alice.' }] });
  await pending;
  assert.equal(db.deeds(0)[0].tool, 'heal_player');
  assert.equal(await bot.summary(0), 'Today I patched up alice.');
  assert.match(client.calls[2].messages[0].content, /heal_player/);
  assert.equal(await setup([]).bot.summary(0), null);
});

test('an idle turn builds within its limits, says what it is up to, and is kept as its own idea', async () => {
  const big = { item: 'default:wood', x1: 0, y1: 0, z1: 0, x2: 9, y2: 9, z2: 9 }; // 1000 blocks
  const small = { item: 'default:wood', x1: 0, y1: 0, z1: 0, x2: 1, y2: 1, z2: 1 };
  const { db, game, bot, client } = setup([
    () => ({ stop_reason: 'tool_use', usage: {}, content: [
      { type: 'tool_use', id: 'a', name: 'fill_box', input: big },
      { type: 'tool_use', id: 'b', name: 'give_item', input: { player: 'alice', item: 'default:dirt' } }] }),
    () => ({ stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', id: 'c', name: 'fill_box', input: small }] }),
    text('Building a little wooden cube!'),
  ]);
  game.sync({ players: [{ name: 'alice', pos: { x: 0, y: 0, z: 0 }, hp: 20, privs: [] }] });
  const said = [];
  const turn = bot.idle((t) => said.push(t));
  await new Promise((r) => setTimeout(r, 10));
  const { actions } = game.sync({});
  assert.equal(actions.length, 1);
  assert.equal(actions[0].nodes.length, 8);
  game.sync({ results: [{ id: actions[0].id, ok: true, message: 'Placed 8 blocks.' }] });
  assert.equal(await turn, 'Building a little wooden cube!');
  const firstResults = client.calls[1].messages[2].content;
  assert.match(firstResults[0].content, /400 blocks/);
  assert.match(firstResults[1].content, /not for your own turns/);
  assert.equal(db.deeds(0)[0].who, 'Blocky (own idea)');
  assert.deepEqual(said, ['Building a little wooden cube!']);
});

test('no idle turn with nobody online, when switched off, or past the hourly limit', async () => {
  const { db, game, bot } = setup([text('QUIET'), text('Hi')]);
  assert.equal(await bot.idle(() => {}), null); // nobody online
  game.sync({ players: [{ name: 'alice', pos: { x: 0, y: 0, z: 0 }, hp: 20, privs: [] }] });
  assert.equal(await bot.idle(() => {}), null); // chose QUIET
  db.putJson('bot', { idle: { enabled: true, after: 60, perHour: 1 } });
  assert.equal(await bot.idle(() => {}), null); // the QUIET turn used the hour's one
  db.putJson('bot', { idle: { enabled: false } });
  assert.equal(await bot.idle(() => {}), null);
});

test('a prank needs real hostility, places only harmless blocks into air, and only once a day', async () => {
  const blocks = [{ x: 1, y: 2, z: 3, item: 'default:gravel' }, { x: 1, y: 3, z: 3, item: 'default:mese' }];
  const prankOnce = () => () => ({ stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', id: 'p', name: 'prank',
    input: { person: 'alice', blocks } }] });
  const { db, game, bot, client, tick } = setup([prankOnce(), text('Hmph.'), prankOnce(), text('Hmph!'), prankOnce(), text('Again!'),
    text('Bah.')]);
  tick(5 * 86_400_000);
  db.putJson('bot', { cooldown: 0 });
  game.sync({ players: [{ name: 'alice', pos: { x: 0, y: 0, z: 0 }, hp: 20, privs: [] }] });
  db.meet('game:alice', 'alice');
  const hear = () => bot.hear({ source: 'game', name: 'alice', text: 'Moss, you old rock', personId: 'game:alice' }, () => {});
  await hear();
  assert.match(client.calls[1].messages[2].content[0].content, /not angry enough/);
  db.feel('moss', 'game:alice', -50, 10);
  const pending = hear();
  await new Promise((r) => setTimeout(r, 10));
  const { actions } = game.sync({});
  assert.deepEqual([actions[0].type, actions[0].soft, actions[0].nodes.length, actions[0].by], ['place', true, 1, 'moss']);
  game.sync({ results: [{ id: actions[0].id, ok: true, message: 'Placed 1 blocks.' }] });
  await pending;
  await hear();
  assert.match(client.calls[5].messages[2].content[0].content, /already pranked alice today/);
  // Switched off, the tool is not even offered.
  db.putJson('bot', { cooldown: 0, pranks: false });
  await hear();
  assert.ok(!client.calls[6].tools.some((t) => t.name === 'prank'));
});
