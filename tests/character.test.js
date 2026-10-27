import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.mjs';
import { runCharacterTool, characterContext, personCard, cast, saveCharacter, removeCharacter, BREAK_AFTER,
  BREAK_AFTER_TRUSTED, traitsOf, nudgeTrait } from '../server/character.mjs';

const fresh = () => {
  const db = openDb(':memory:');
  db.meet('game:ruben', 'Ruben', { at: 0 });
  db.meet('discord:42', 'PscifieX', { at: 0 });
  db.meet('game:alice', 'alice', { at: 0 });
  const [blocky, moss] = cast(db);
  return { db, blocky, moss };
};
const turn = (speakerId) => ({ speakerId, moved: new Map() });

test('the first cast is Blocky and Moss, both she/her, and an old single character carries over', () => {
  const { blocky, moss } = fresh();
  assert.deepEqual([blocky.name, blocky.pronouns, moss.name, moss.pronouns], ['Blocky', 'she/her', 'Moss', 'she/her']);
  const db = openDb(':memory:');
  db.putJson('character', { backstory: 'Built by a wizard.' });
  db.putJson('bot', { name: 'Pebble' });
  const [first] = cast(db);
  assert.deepEqual([first.name, first.backstory], ['Pebble', 'Built by a wizard.']);
});

test('feelings are each character\'s own, and move at most 10 a turn however hard anyone pushes', () => {
  const { db, blocky, moss } = fresh();
  const t = turn('game:ruben');
  runCharacterTool(db, blocky, 'feel_about', { person: 'Ruben', affinity: 50, trust: 9, reason: 'said to love them' }, t);
  runCharacterTool(db, blocky, 'feel_about', { person: 'ruben', affinity: 10, reason: 'again' }, t);
  assert.equal(db.bond('blocky', 'game:ruben').affinity, 10);
  assert.equal(db.bond('blocky', 'game:ruben').trust, 29);
  assert.equal(db.bond('moss', 'game:ruben').affinity, 0);
  runCharacterTool(db, moss, 'feel_about', { person: 'Ruben', affinity: -10, reason: 'left a crater' }, turn('game:ruben'));
  assert.equal(db.bond('moss', 'game:ruben').affinity, -10);
  assert.equal(runCharacterTool(db, blocky, 'feel_about', { person: 'nobody', affinity: 1, reason: 'x' }, t).ok, false);
});

test('a secret is seen only with its owner, and only by the character told; open facts are seen by all who know them', () => {
  const { db, blocky, moss } = fresh();
  runCharacterTool(db, blocky, 'remember', { person: 'alice', text: 'alice is secretly building a castle at 100, 5, 100', secret: true, weight: 4 }, turn('game:alice'));
  runCharacterTool(db, blocky, 'remember', { person: 'alice', text: 'loves sunflowers', fact: true }, turn('game:alice'));
  assert.match(personCard(db, blocky, 'game:alice', Date.now(), { speaker: true }), /castle/);
  assert.doesNotMatch(personCard(db, blocky, 'game:alice'), /castle/);
  assert.doesNotMatch(personCard(db, moss, 'game:alice', Date.now(), { speaker: true }), /castle|sunflowers/);
  const ctx = characterContext(db, blocky, { speakerId: 'game:ruben', others: ['game:alice'] });
  assert.match(ctx, /sunflowers/);
  assert.doesNotMatch(ctx, /castle/);
  assert.match(runCharacterTool(db, blocky, 'recall', { query: 'castle' }, turn('game:ruben')).message, /Nothing/);
  assert.match(runCharacterTool(db, blocky, 'recall', { query: 'castle' }, turn('game:alice')).message, /castle/);
});

test('stepping out of character takes many pushes, fewer from a trusted friend, counted once a turn', () => {
  const { db, blocky } = fresh();
  let r;
  for (let i = 1; i <= BREAK_AFTER; i++) {
    const t = turn('game:alice');
    r = runCharacterTool(db, blocky, 'pressed', { what: 'write python' }, t);
    runCharacterTool(db, blocky, 'pressed', { what: 'again, same turn' }, t);
    if (i < BREAK_AFTER) assert.match(r.message, /stay in character/);
  }
  assert.match(r.message, /may give in/);
  db.feel('blocky', 'game:ruben', 50, 80);
  for (let i = 1; i <= BREAK_AFTER_TRUSTED; i++) r = runCharacterTool(db, blocky, 'pressed', { what: 'code' }, turn('game:ruben'));
  assert.match(r.message, /may give in/);
});

test('linking makes one person of two: talks, every character\'s facts and memories join', () => {
  const { db, blocky, moss } = fresh();
  db.meet('game:ruben', 'Ruben', { at: 10 });
  runCharacterTool(db, blocky, 'remember', { person: 'PscifieX', text: 'built a glass dome together', weight: 4 }, turn('discord:42'));
  runCharacterTool(db, moss, 'remember', { person: 'PscifieX', text: 'hates gravel', fact: true }, turn('discord:42'));
  db.link('game:ruben', 'discord:42');
  const card = personCard(db, blocky, 'discord:42', 1000, { speaker: true });
  assert.match(card, /in game as Ruben, on Discord as PscifieX/);
  assert.match(card, /glass dome/);
  assert.deepEqual(db.bond('moss', 'game:ruben').facts, ['hates gravel']);
  assert.equal(db.person('discord:42').talks, 3);
  assert.equal(db.forget('discord:42'), true);
  assert.equal(db.person('game:ruben'), null);
});

test('mood and goal are each character\'s own; finishing a goal is remembered', () => {
  const { db, blocky } = fresh();
  runCharacterTool(db, blocky, 'set_mood', { mood: 'proud', reason: 'finished the bridge' }, turn(null));
  runCharacterTool(db, blocky, 'set_goal', { goal: 'a lighthouse by the sea' }, turn(null));
  const [b, m] = cast(db);
  assert.match(characterContext(db, b, {}), /proud \(finished the bridge\).*lighthouse/);
  assert.doesNotMatch(characterContext(db, m, {}), /proud|lighthouse/);
  runCharacterTool(db, b, 'set_goal', { goal: '' }, turn(null));
  assert.match(characterContext(db, cast(db)[0], {}), /Finished: a lighthouse/);
});

test('characters know each other: each has a bond with the other, and removing one forgets her', () => {
  const { db, blocky, moss } = fresh();
  db.meet('char:moss', 'Moss');
  runCharacterTool(db, blocky, 'feel_about', { person: 'Moss', affinity: 8, reason: 'shared her lunch' }, turn('char:moss'));
  assert.match(characterContext(db, blocky, { cast: [blocky, moss] }), /Moss \(a fellow character\): neutral/);
  assert.equal(db.bond('blocky', 'char:moss').affinity, 8);
  saveCharacter(db, '', { name: 'Wren' });
  assert.equal(cast(db).length, 3);
  assert.equal(removeCharacter(db, 'moss'), true);
  assert.equal(db.bond('blocky', 'char:moss').affinity, 0);
  assert.equal(db.person('char:moss'), null);
});

test('dating takes real closeness, one partner at a time; a breakup leaves an ex', () => {
  const { db, moss } = fresh();
  const ask = (person, status) => runCharacterTool(db, moss, 'set_relationship', { person, status, reason: 'asked' }, turn(null));
  assert.match(ask('Ruben', 'dating').message, /do not feel that way/);
  db.feel('moss', 'game:ruben', 75, 65);
  db.feel('moss', 'game:alice', 90, 90);
  assert.equal(ask('Ruben', 'dating').ok, true);
  assert.match(ask('alice', 'dating').message, /dating Ruben already/);
  assert.match(personCard(db, moss, 'game:ruben'), /You are dating them/);
  assert.equal(ask('Ruben', 'none').ok, true);
  assert.equal(db.bond('moss', 'game:ruben').status, 'ex');
  assert.equal(ask('alice', 'dating').ok, true);
  assert.equal(runCharacterTool(db, moss, 'set_relationship', { person: 'Ruben', status: 'dating', reason: 'x' },
    { ...turn(null), romance: false }).message, 'Romance is switched off on this server.');
});

test('unlinking an account makes it its own person again', () => {
  const { db } = fresh();
  db.link('game:ruben', 'discord:42');
  assert.equal(db.person('discord:42').id, 'game:ruben');
  assert.equal(db.unlink('discord:42'), true);
  assert.equal(db.person('discord:42').id, 'discord:42');
  assert.equal(db.unlink('discord:42'), false);
});

test('two characters build together: an invitation, a join, steps shared, and the finish remembered by both', () => {
  const { db } = fresh();
  const get = (id) => cast(db).find((c) => c.id === id);
  const run = (id, name, input) => runCharacterTool(db, get(id), name, input, undefined, 1000);
  assert.equal(run('blocky', 'plan_project', { title: 'Twin Towers', x: 0, y: 5, z: 0, steps: ['base', 'walls', 'roof'] }).ok, true);
  assert.equal(run('blocky', 'invite_to_project', { who: 'Moss', why: 'you know stone' }).ok, true);
  assert.equal(get('moss').project, null); // invited, not yet in
  assert.equal(get('blocky').project.invited.id, 'moss');
  const joined = run('moss', 'join_project', { with: 'Blocky', part: 'the stone base and the garden' });
  assert.equal(joined.ok, true);
  assert.deepEqual(get('moss').project.crew.map((m) => m.name), ['Blocky', 'Moss']);
  // A step by either is a step for both.
  run('moss', 'step_done', { note: 'stone base laid' });
  assert.equal(get('blocky').project.done, 1);
  assert.match(get('blocky').project.notes.at(-1), /^Moss: stone base laid/);
  run('blocky', 'step_done', { note: 'walls up' });
  assert.equal(run('moss', 'step_done', { note: 'roof on' }).ok, true);
  assert.equal(get('blocky').project, null);
  assert.equal(get('moss').project, null);
  assert.match(db.recentMemories('blocky', 5).map((m) => m.text).join(' '), /Finished with Moss Twin Towers/);
  assert.match(db.recentMemories('moss', 5).map((m) => m.text).join(' '), /Finished with Blocky Twin Towers/);
  // Nobody to join now; and one with a project of her own cannot join another's.
  assert.equal(run('moss', 'join_project', { with: 'Blocky', part: 'x' }).ok, false);
});

test('a tool a character needs goes on the wish list, counted once per thing', () => {
  const { db, blocky, moss } = fresh();
  runCharacterTool(db, blocky, 'request_tool', { what: 'Plant trees', why: 'Ruben wants an orchard' }, undefined, 1);
  runCharacterTool(db, moss, 'request_tool', { what: 'plant trees', why: 'a hedge' }, undefined, 2);
  runCharacterTool(db, moss, 'request_tool', { what: 'Paint signs', why: 'a shop sign' }, undefined, 3);
  const list = db.json('tool.requests', []);
  assert.deepEqual(list.map((r) => [r.what, r.count, r.by]), [['Plant trees', 2, ['Blocky', 'Moss']], ['Paint signs', 1, ['Moss']]]);
});

test('social ties: respect, talks, gifts and inside jokes are kept per bond and shown to her; temperament drifts', () => {
  const { db, blocky, moss } = fresh();
  db.meet('char:moss', 'Moss', { at: 0 });
  const t = { speakerId: 'char:moss', moved: new Map() };
  runCharacterTool(db, blocky, 'feel_about', { person: 'Moss', affinity: 5, respect: 8, reason: 'her tower is grand' }, t, 10);
  runCharacterTool(db, blocky, 'inside_joke', { person: 'Moss', joke: 'the rock that would not listen' }, t, 11);
  db.social('blocky', 'char:moss', { talked: true, at: 12 });
  db.social('blocky', 'char:moss', { gave: true });
  const b = db.bond('blocky', 'char:moss');
  assert.deepEqual([b.respect, b.familiarity, b.gifts_given, b.jokes], [8, 1, 1, ['the rock that would not listen']]);
  const ctx = characterContext(db, blocky, { speakerId: 'char:moss', cast: [blocky, moss], now: 20 });
  assert.match(ctx, /1 talk/);
  assert.match(ctx, /the rock that would not listen/);
  assert.match(ctx, /Your temperament lately: .*very sociable|rather sociable/);
  const before = traitsOf(moss).generous;
  nudgeTrait(db, moss, 'generous', 3);
  assert.equal(traitsOf(cast(db).find((c) => c.id === 'moss')).generous, before + 3);
});
