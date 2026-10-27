// The sidecar's storage: SQLite on the Fly volume (node:sqlite, built into Node 22+), next to the world.
// Settings an admin changes on /admin, the server's own secrets, the chat log the admin page and the bot
// read, and what the LLM has cost, a row a day.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

// Colours for people's names on Discord, readable on a dark and a light theme, each person one of them for good.
export const PALETTE = ['#e06c75', '#e5a046', '#d6c34a', '#7bc96f', '#45b5a0', '#4fa3e0', '#7d8cf0', '#b67be8',
  '#e57bb5', '#c98a5b', '#8fb83f', '#5bc0de'];

// Chat kept for the admin page and the bot's context; older lines are dropped.
const CHAT_KEEP = 2000;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chat (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, source TEXT NOT NULL, name TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, who TEXT NOT NULL, tool TEXT NOT NULL,
      input TEXT NOT NULL, result TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, link TEXT, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
      talks INTEGER NOT NULL DEFAULT 0, affinity INTEGER NOT NULL DEFAULT 0, trust INTEGER NOT NULL DEFAULT 20,
      nickname TEXT, facts TEXT NOT NULL DEFAULT '[]', pressure INTEGER NOT NULL DEFAULT 0, pressure_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS bonds (
      character TEXT NOT NULL, person TEXT NOT NULL, affinity INTEGER NOT NULL DEFAULT 0, trust INTEGER NOT NULL DEFAULT 20,
      nickname TEXT, facts TEXT NOT NULL DEFAULT '[]', pressure INTEGER NOT NULL DEFAULT 0, pressure_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (character, person)
    );
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, about TEXT, text TEXT NOT NULL, weight INTEGER NOT NULL,
      secret INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS memories_about ON memories (about, at);
    CREATE TABLE IF NOT EXISTS usage (
      day TEXT PRIMARY KEY, calls INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL
    );
  `);
  // Before several characters, memories and feelings were Blocky's alone: they become Blocky's.
  if (!db.prepare('PRAGMA table_info(memories)').all().some((c) => c.name === 'character')) {
    db.exec(`ALTER TABLE memories ADD COLUMN character TEXT NOT NULL DEFAULT 'blocky';
      CREATE INDEX IF NOT EXISTS memories_character ON memories (character, about, at);`);
    db.exec(`INSERT OR IGNORE INTO bonds (character, person, affinity, trust, nickname, facts, pressure, pressure_at)
      SELECT 'blocky', id, affinity, trust, nickname, facts, pressure, pressure_at FROM people WHERE link IS NULL`);
  }
  // Relationship status (dating, ex) and the last prank, added after bonds first shipped.
  const bondCols = db.prepare('PRAGMA table_info(bonds)').all().map((c) => c.name);
  if (!bondCols.includes('status')) db.exec("ALTER TABLE bonds ADD COLUMN status TEXT NOT NULL DEFAULT 'none'");
  if (!bondCols.includes('pranked_at')) db.exec('ALTER TABLE bonds ADD COLUMN pranked_at INTEGER NOT NULL DEFAULT 0');
  if (!db.prepare('PRAGMA table_info(people)').all().some((c) => c.name === 'color')) db.exec('ALTER TABLE people ADD COLUMN color TEXT');
  const q = {
    setting: db.prepare('SELECT value FROM settings WHERE name = ?'),
    addSetting: db.prepare('INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)'),
    putSetting: db.prepare(`INSERT INTO settings (name, value) VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET value = excluded.value`),
    dropSetting: db.prepare('DELETE FROM settings WHERE name = ?'),
    addChat: db.prepare('INSERT INTO chat (at, source, name, text) VALUES (?, ?, ?, ?)'),
    trimChat: db.prepare('DELETE FROM chat WHERE id <= (SELECT MAX(id) FROM chat) - ?'),
    chat: db.prepare('SELECT id, at, source, name, text FROM chat ORDER BY id DESC LIMIT ?'),
    addUsage: db.prepare(`INSERT INTO usage (day, calls, input, output) VALUES (?, 1, ?, ?)
      ON CONFLICT(day) DO UPDATE SET calls = calls + 1, input = input + excluded.input, output = output + excluded.output`),
    usage: db.prepare('SELECT day, calls, input, output FROM usage ORDER BY day DESC LIMIT ?'),
    addDeed: db.prepare('INSERT INTO deeds (at, who, tool, input, result) VALUES (?, ?, ?, ?, ?)'),
    deeds: db.prepare('SELECT at, who, tool, input, result FROM deeds WHERE at >= ? ORDER BY id LIMIT 500'),
    chatSince: db.prepare('SELECT at, source, name, text FROM chat WHERE at >= ? ORDER BY id LIMIT 400'),
    rawPerson: db.prepare('SELECT id, name, link, first_at, last_at, talks, color FROM people WHERE id = ?'),
    setColor: db.prepare('UPDATE people SET color = ? WHERE id = ?'),
    addPerson: db.prepare(`INSERT INTO people (id, name, first_at, last_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name`),
    touchPerson: db.prepare('UPDATE people SET talks = talks + 1, last_at = ? WHERE id = ?'),
    seenPerson: db.prepare('UPDATE people SET last_at = MAX(last_at, ?) WHERE id = ?'),
    setLink: db.prepare('UPDATE people SET link = ? WHERE id = ?'),
    mergeStats: db.prepare(`UPDATE people SET talks = talks + ?, first_at = MIN(first_at, ?), last_at = MAX(last_at, ?)
      WHERE id = ?`),
    people: db.prepare('SELECT id, name, link, first_at, last_at, talks, color FROM people WHERE link IS NULL ORDER BY last_at DESC LIMIT ?'),
    aliases: db.prepare('SELECT id, name FROM people WHERE link = ?'),
    byName: db.prepare('SELECT id FROM people WHERE lower(name) = lower(?) ORDER BY last_at DESC'),
    byNickname: db.prepare('SELECT person AS id FROM bonds WHERE character = ? AND lower(nickname) = lower(?)'),
    dropPerson: db.prepare('DELETE FROM people WHERE id = ? OR link = ?'),
    bond: db.prepare('SELECT * FROM bonds WHERE character = ? AND person = ?'),
    bondsOf: db.prepare('SELECT * FROM bonds WHERE person = ?'),
    addBond: db.prepare('INSERT OR IGNORE INTO bonds (character, person) VALUES (?, ?)'),
    setFeel: db.prepare('UPDATE bonds SET affinity = ?, trust = ? WHERE character = ? AND person = ?'),
    setNick: db.prepare('UPDATE bonds SET nickname = ? WHERE character = ? AND person = ?'),
    setFacts: db.prepare('UPDATE bonds SET facts = ? WHERE character = ? AND person = ?'),
    setPressure: db.prepare('UPDATE bonds SET pressure = ?, pressure_at = ? WHERE character = ? AND person = ?'),
    setStatus: db.prepare('UPDATE bonds SET status = ? WHERE character = ? AND person = ?'),
    setPranked: db.prepare('UPDATE bonds SET pranked_at = ? WHERE character = ? AND person = ?'),
    dating: db.prepare("SELECT person FROM bonds WHERE character = ? AND status = 'dating'"),
    moveBond: db.prepare('UPDATE bonds SET person = ? WHERE character = ? AND person = ?'),
    dropBonds: db.prepare('DELETE FROM bonds WHERE person = ?'),
    dropCharacterBonds: db.prepare('DELETE FROM bonds WHERE character = ? OR person = ?'),
    addMemory: db.prepare('INSERT INTO memories (at, character, about, text, weight, secret) VALUES (?, ?, ?, ?, ?, ?)'),
    // Secrets (told in confidence) come back only with their own person: memoriesAbout with them, and never in
    // recent or found memories, which any turn may read.
    memoriesAbout: db.prepare(`SELECT id, at, character, about, text, weight, secret FROM memories
      WHERE character = ? AND about = ? AND (secret = 0 OR ?) ORDER BY weight DESC, at DESC LIMIT ?`),
    memoriesRecent: db.prepare(`SELECT id, at, character, about, text, weight, secret FROM memories
      WHERE character = ? AND about IS NULL AND weight >= ? AND secret = 0 ORDER BY at DESC LIMIT ?`),
    memoriesFind: db.prepare(`SELECT id, at, character, about, text, weight, secret FROM memories
      WHERE character = ? AND text LIKE ? ESCAPE '\\' AND (secret = 0 OR about = ?) ORDER BY weight DESC, at DESC LIMIT ?`),
    memoriesAll: db.prepare('SELECT id, at, character, about, text, weight, secret FROM memories ORDER BY at DESC LIMIT ?'),
    moveMemories: db.prepare('UPDATE memories SET about = ? WHERE about = ?'),
    dropMemory: db.prepare('DELETE FROM memories WHERE id = ?'),
    dropMemoriesAbout: db.prepare('DELETE FROM memories WHERE about = ?'),
    dropCharacterMemories: db.prepare('DELETE FROM memories WHERE character = ? OR about = ?'),
  };
  const facts = (r) => { try { return JSON.parse(r.facts); } catch { return []; } };
  const bondOut = (r) => ({ affinity: r?.affinity ?? 0, trust: r?.trust ?? 20, nickname: r?.nickname ?? null,
    facts: r ? facts(r) : [], pressure: r?.pressure ?? 0, pressure_at: r?.pressure_at ?? 0, status: r?.status ?? 'none',
    pranked_at: r?.pranked_at ?? 0 });
  // A person's own row: an alias (a linked Discord or game identity) leads to the one it was linked to.
  const canonical = (id) => {
    const r = q.rawPerson.get(id);
    return r?.link ? q.rawPerson.get(r.link) ?? r : r;
  };
  let added = 0;
  return {
    setting: (name) => q.setting.get(name)?.value ?? null,
    putSetting: (name, value) => { q.putSetting.run(name, String(value)); },
    dropSetting: (name) => { q.dropSetting.run(name); },
    /** A JSON setting, or `fallback` when unset or unreadable. */
    json(name, fallback) {
      try { return JSON.parse(q.setting.get(name)?.value ?? 'null') ?? fallback; } catch { return fallback; }
    },
    putJson: (name, value) => { q.putSetting.run(name, JSON.stringify(value)); },
    /** A random secret made once and kept, so nothing needs setting up. */
    secret(name) {
      q.addSetting.run(`secret.${name}`, randomBytes(32).toString('base64url'));
      return q.setting.get(`secret.${name}`).value;
    },
    /** One chat line. source: 'game', 'discord', 'bot' or 'admin'. */
    addChat(source, name, text, at = Date.now()) {
      q.addChat.run(at, source, String(name).slice(0, 64), String(text).slice(0, 1000));
      if (++added % 100 === 0) q.trimChat.run(CHAT_KEEP);
    },
    /** The newest `n` lines, oldest first. */
    chat: (n = 50) => q.chat.all(n).reverse(),
    addUsage(input, output, at = Date.now()) {
      q.addUsage.run(new Date(at).toISOString().slice(0, 10), input | 0, output | 0);
    },
    usage: (days = 14) => q.usage.all(days),
    /** Something the AI did in the world, for the daily summary. */
    addDeed(who, tool, input, result, at = Date.now()) {
      q.addDeed.run(at, String(who).slice(0, 64), tool, JSON.stringify(input ?? {}).slice(0, 2000), String(result).slice(0, 500));
    },
    deeds: (since) => q.deeds.all(since),
    chatSince: (since) => q.chatSince.all(since),

    // ---- People the characters know, and what each remembers (server/character.mjs) ----
    // A person's id is where they were met: game:<name in lower case>, discord:<Discord user id>, or char:<id> for
    // another character. Linking two makes the second an alias of the first: one person, whose bonds (how each
    // character feels about them) and memories join. `ch` below is a character's id.

    /** The person (their own row, aliases followed); null if never met. */
    person: (id) => canonical(id) ?? null,
    /** Meet or greet: makes the person if new, counts a talk when `talked`. Returns their row. */
    meet(id, name, { at = Date.now(), talked = true } = {}) {
      q.addPerson.run(id, String(name).slice(0, 64), at, at);
      const own = canonical(id);
      if (talked) q.touchPerson.run(at, own.id);
      else q.seenPerson.run(at, own.id);
      return q.rawPerson.get(own.id);
    },
    /** How character `ch` feels about a person: { affinity, trust, nickname, facts, pressure, pressure_at }. */
    bond(ch, id) { const own = canonical(id); return bondOut(own && q.bond.get(ch, own.id)); },
    /** Set how `ch` feels: affinity -100..100, trust 0..100. */
    feel(ch, id, affinity, trust) {
      const own = canonical(id);
      if (!own) return;
      q.addBond.run(ch, own.id);
      q.setFeel.run(Math.max(-100, Math.min(100, Math.round(affinity))), Math.max(0, Math.min(100, Math.round(trust))), ch, own.id);
    },
    nickname(ch, id, nick) {
      const own = canonical(id);
      if (!own) return;
      q.addBond.run(ch, own.id);
      q.setNick.run(nick ? String(nick).slice(0, 32) : null, ch, own.id);
    },
    /** Keep a fact `ch` knows about a person: the newest 20, no repeats. */
    addFact(ch, id, fact) {
      const own = canonical(id);
      if (!own) return;
      q.addBond.run(ch, own.id);
      const kept = bondOut(q.bond.get(ch, own.id)).facts.filter((f) => f.toLowerCase() !== String(fact).toLowerCase());
      kept.push(String(fact).slice(0, 200));
      q.setFacts.run(JSON.stringify(kept.slice(-20)), ch, own.id);
    },
    /** Make `other` an alias of `keep`: talks, bonds (keep's feelings win, facts join) and memories join. */
    link(keep, other) {
      const a = canonical(keep);
      const b = canonical(other);
      if (!a || !b || a.id === b.id) return false;
      q.mergeStats.run(b.talks, b.first_at, b.last_at, a.id);
      for (const bb of q.bondsOf.all(b.id)) {
        const ab = q.bond.get(bb.character, a.id);
        if (!ab) { q.moveBond.run(a.id, bb.character, b.id); continue; }
        const both = [...facts(ab), ...facts(bb).filter((f) => !facts(ab).includes(f))];
        q.setFacts.run(JSON.stringify(both.slice(-20)), bb.character, a.id);
      }
      q.dropBonds.run(b.id);
      q.moveMemories.run(a.id, b.id);
      for (const alias of q.aliases.all(b.id)) q.setLink.run(a.id, alias.id);
      q.setLink.run(a.id, b.id);
      return true;
    },
    /** Everyone known (own rows), most recently seen first, with aliases and each character's bond. */
    people: (n = 200) => q.people.all(n).map((r) => ({ ...r, aliases: q.aliases.all(r.id),
      bonds: Object.fromEntries(q.bondsOf.all(r.id).map((b) => [b.character, bondOut(b)])) })),
    /** Own rows of people known by this name (any of theirs) or by `ch`'s nickname for them, latest first. */
    peopleNamed(ch, name) {
      const ids = [...q.byNickname.all(ch, name), ...q.byName.all(name)].map((r) => canonical(r.id)?.id).filter(Boolean);
      return [...new Set(ids)].map((id) => q.rawPerson.get(id));
    },
    forget(id) {
      const own = canonical(id);
      if (!own) return false;
      for (const alias of q.aliases.all(own.id)) { q.dropMemoriesAbout.run(alias.id); q.dropBonds.run(alias.id); }
      q.dropMemoriesAbout.run(own.id);
      q.dropBonds.run(own.id);
      q.dropPerson.run(own.id, own.id);
      return true;
    },
    /** A character gone: its feelings and memories go, and others forget it as a person. */
    dropCharacter(ch) {
      q.dropCharacterBonds.run(ch, `char:${ch}`);
      q.dropCharacterMemories.run(ch, `char:${ch}`);
      q.dropPerson.run(`char:${ch}`, `char:${ch}`);
    },
    /** A memory of `ch`'s: about a person (their id) or the world (null), weight 1 (passing) to 5 (unforgettable). */
    remember(ch, about, text, weight = 2, at = Date.now(), { secret = false } = {}) {
      const own = about ? canonical(about)?.id ?? about : null;
      q.addMemory.run(at, ch, own, String(text).slice(0, 300), Math.max(1, Math.min(5, Math.round(weight))), secret && own ? 1 : 0);
    },
    /** `ch`'s memories about a person; their secrets only with `withSecrets` (when they are the one talking). */
    memoriesAbout: (ch, id, n = 8, { withSecrets = false } = {}) => {
      const own = canonical(id);
      return own ? q.memoriesAbout.all(ch, own.id, withSecrets ? 1 : 0, n) : [];
    },
    /** `ch`'s own memories (not about anyone), newest first. */
    recentMemories: (ch, n = 8, minWeight = 1) => q.memoriesRecent.all(ch, minWeight, n),
    /** `ch`'s memories with these words; secrets only those of `asker` (an id), when given. */
    findMemories: (ch, text, n = 8, asker = null) => q.memoriesFind.all(ch, `%${String(text).replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
      asker ? canonical(asker)?.id ?? asker : '', n),
    allMemories: (n = 100) => q.memoriesAll.all(n),
    /** A person's colour on Discord: the one an admin picked, else one from PALETTE that stays theirs. */
    colorOf(id) {
      const own = canonical(id);
      if (own?.color) return own.color;
      let h = 0;
      for (const ch of String(own?.id ?? id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return PALETTE[h % PALETTE.length];
    },
    setColor(id, color) {
      const own = canonical(id);
      if (own && (color === null || /^#[0-9a-f]{6}$/i.test(color))) q.setColor.run(color, own.id);
    },
    /** `ch` and a person: 'none', 'dating' or 'ex'. */
    setStatus(ch, id, status) {
      const own = canonical(id);
      if (!own) return;
      q.addBond.run(ch, own.id);
      q.setStatus.run(status, ch, own.id);
    },
    /** Who `ch` is dating, if anyone (a person id). */
    partner: (ch) => q.dating.get(ch)?.person ?? null,
    pranked(ch, id, at = Date.now()) {
      const own = canonical(id);
      if (!own) return;
      q.addBond.run(ch, own.id);
      q.setPranked.run(at, ch, own.id);
    },
    /** Times this person pushed `ch` out of character lately; it fades after a day of peace. */
    pressure(ch, id, at = Date.now()) {
      const b = this.bond(ch, id);
      return at - b.pressure_at > 86_400_000 ? 0 : b.pressure;
    },
    press(ch, id, at = Date.now()) {
      const own = canonical(id);
      if (!own) return 0;
      q.addBond.run(ch, own.id);
      const n = this.pressure(ch, id, at) + 1;
      q.setPressure.run(n, at, ch, own.id);
      return n;
    },
    dropMemory: (id) => q.dropMemory.run(id).changes > 0,
    close: () => db.close(),
  };
}
