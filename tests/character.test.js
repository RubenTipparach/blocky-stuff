import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.mjs';
import { runCharacterTool, characterContext, personCard, cast, saveCharacter, removeCharacter, BREAK_AFTER,
  BREAK_AFTER_TRUSTED } from '../server/character.mjs';

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
