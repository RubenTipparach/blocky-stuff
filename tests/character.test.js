import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.mjs';
import { runCharacterTool, characterContext, personCard, BREAK_AFTER, BREAK_AFTER_TRUSTED } from '../server/character.mjs';

const fresh = () => {
  const db = openDb(':memory:');
  db.meet('game:ruben', 'Ruben', { at: 0 });
  db.meet('discord:42', 'PscifieX', { at: 0 });
  db.meet('game:alice', 'alice', { at: 0 });
  return db;
};
const turn = (speakerId) => ({ speakerId, moved: new Map() });

test('feelings move at most 10 a turn, however hard the model or the player pushes', () => {
  const db = fresh();
  const t = turn('game:ruben');
  runCharacterTool(db, 'feel_about', { person: 'Ruben', affinity: 50, trust: 9, reason: 'said to love them' }, t);
  runCharacterTool(db, 'feel_about', { person: 'ruben', affinity: 10, reason: 'again' }, t);
  assert.equal(db.person('game:ruben').affinity, 10);
  assert.equal(db.person('game:ruben').trust, 29);
  // A new turn may move them again.
  runCharacterTool(db, 'feel_about', { person: 'Ruben', affinity: -10, reason: 'griefed a house' }, turn('game:ruben'));
  assert.equal(db.person('game:ruben').affinity, 0);
  assert.equal(runCharacterTool(db, 'feel_about', { person: 'nobody', affinity: 1, reason: 'x' }, t).ok, false);
});

test('a secret is seen only with its owner; open facts and memories are seen by all', () => {
  const db = fresh();
  runCharacterTool(db, 'remember', { person: 'alice', text: 'alice is secretly building a castle at 100, 5, 100', secret: true, weight: 4 }, turn('game:alice'));
  runCharacterTool(db, 'remember', { person: 'alice', text: 'loves sunflowers', fact: true }, turn('game:alice'));
  assert.match(personCard(db, 'game:alice', Date.now(), { speaker: true }), /castle/);
  assert.doesNotMatch(personCard(db, 'game:alice'), /castle/);
  const ctx = characterContext(db, { speakerId: 'game:ruben', others: ['game:alice'] });
  assert.match(ctx, /sunflowers/);
  assert.doesNotMatch(ctx, /castle/);
  assert.match(runCharacterTool(db, 'recall', { query: 'castle' }, turn('game:ruben')).message, /Nothing/);
  assert.match(runCharacterTool(db, 'recall', { query: 'castle' }, turn('game:alice')).message, /castle/);
});

test('stepping out of character takes many pushes, fewer from a trusted friend, counted once a turn', () => {
  const db = fresh();
  let r;
  for (let i = 1; i <= BREAK_AFTER; i++) {
    const t = turn('game:alice');
    r = runCharacterTool(db, 'pressed', { what: 'write python' }, t);
    runCharacterTool(db, 'pressed', { what: 'again, same turn' }, t);
    if (i < BREAK_AFTER) assert.match(r.message, /stay in character/);
  }
  assert.match(r.message, /may give in/);
  db.feel('game:ruben', 50, 80);
  for (let i = 1; i <= BREAK_AFTER_TRUSTED; i++) r = runCharacterTool(db, 'pressed', { what: 'code' }, turn('game:ruben'));
  assert.match(r.message, /may give in/);
});

test('linking makes one person of two: talks, facts and memories join', () => {
  const db = fresh();
  db.meet('game:ruben', 'Ruben', { at: 10 });
  runCharacterTool(db, 'remember', { person: 'PscifieX', text: 'built a glass dome together', weight: 4 }, turn('discord:42'));
  db.link('game:ruben', 'discord:42');
  const card = personCard(db, 'discord:42', 1000, { speaker: true });
  assert.match(card, /in game as Ruben, on Discord as PscifieX/);
  assert.match(card, /glass dome/);
  assert.equal(db.person('discord:42').talks, 3);
  assert.equal(db.forget('discord:42'), true);
  assert.equal(db.person('game:ruben'), null);
});

test('mood and goal show in the context; finishing a goal is remembered', () => {
  const db = fresh();
  runCharacterTool(db, 'set_mood', { mood: 'proud', reason: 'finished the bridge' }, turn(null));
  runCharacterTool(db, 'set_goal', { goal: 'a lighthouse by the sea' }, turn(null));
  assert.match(characterContext(db, {}), /proud \(finished the bridge\).*lighthouse/);
  runCharacterTool(db, 'set_goal', { goal: '' }, turn(null));
  assert.match(characterContext(db, {}), /Finished: a lighthouse/);
});
