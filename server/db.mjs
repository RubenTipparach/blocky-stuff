// The sidecar's storage: SQLite on the Fly volume (node:sqlite, built into Node 22+), next to the world.
// Settings an admin changes on /admin, the server's own secrets, the chat log the admin page and the bot
// read, and what the LLM has cost, a row a day.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

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
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, about TEXT, text TEXT NOT NULL, weight INTEGER NOT NULL,
      secret INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS memories_about ON memories (about, at);
    CREATE TABLE IF NOT EXISTS usage (
      day TEXT PRIMARY KEY, calls INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL
    );
  `);
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
    rawPerson: db.prepare('SELECT * FROM people WHERE id = ?'),
    addPerson: db.prepare(`INSERT INTO people (id, name, first_at, last_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name`),
    touchPerson: db.prepare('UPDATE people SET talks = talks + 1, last_at = ? WHERE id = ?'),
    seenPerson: db.prepare('UPDATE people SET last_at = MAX(last_at, ?) WHERE id = ?'),
    setFeel: db.prepare('UPDATE people SET affinity = ?, trust = ? WHERE id = ?'),
    setNick: db.prepare('UPDATE people SET nickname = ? WHERE id = ?'),
    setFacts: db.prepare('UPDATE people SET facts = ? WHERE id = ?'),
    setLink: db.prepare('UPDATE people SET link = ? WHERE id = ?'),
    mergeStats: db.prepare(`UPDATE people SET talks = talks + ?, first_at = MIN(first_at, ?), last_at = MAX(last_at, ?)
      WHERE id = ?`),
    people: db.prepare('SELECT * FROM people WHERE link IS NULL ORDER BY last_at DESC LIMIT ?'),
    aliases: db.prepare('SELECT id, name FROM people WHERE link = ?'),
    byName: db.prepare('SELECT * FROM people WHERE lower(name) = lower(?) OR lower(nickname) = lower(?) ORDER BY last_at DESC'),
    dropPerson: db.prepare('DELETE FROM people WHERE id = ? OR link = ?'),
    addMemory: db.prepare('INSERT INTO memories (at, about, text, weight, secret) VALUES (?, ?, ?, ?, ?)'),
    // Secrets (told in confidence) come back only with their own person: memoriesAbout with them, and never in
    // recent or found memories, which any turn may read.
    memoriesAbout: db.prepare(`SELECT id, at, about, text, weight, secret FROM memories WHERE about = ? AND (secret = 0 OR ?)
      ORDER BY weight DESC, at DESC LIMIT ?`),
    memoriesRecent: db.prepare('SELECT id, at, about, text, weight, secret FROM memories WHERE weight >= ? AND secret = 0 ORDER BY at DESC LIMIT ?'),
    memoriesFind: db.prepare(`SELECT id, at, about, text, weight, secret FROM memories WHERE text LIKE ? ESCAPE '\\'
      AND (secret = 0 OR about = ?) ORDER BY weight DESC, at DESC LIMIT ?`),
    memoriesAll: db.prepare('SELECT id, at, about, text, weight, secret FROM memories ORDER BY at DESC LIMIT ?'),
    setPressure: db.prepare('UPDATE people SET pressure = ?, pressure_at = ? WHERE id = ?'),
    moveMemories: db.prepare('UPDATE memories SET about = ? WHERE about = ?'),
    dropMemory: db.prepare('DELETE FROM memories WHERE id = ?'),
    dropMemoriesAbout: db.prepare('DELETE FROM memories WHERE about = ?'),
  };
  const rowOut = (r) => (r ? { ...r, facts: (() => { try { return JSON.parse(r.facts); } catch { return []; } })() } : null);
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

    // ---- People the bot knows, and what it remembers (server/character.mjs) ----
    // A person's id is where they were met: game:<name in lower case> or discord:<Discord user id>. Linking two
    // makes the second an alias of the first: one relationship, one set of memories.

    /** The person (their own row, aliases followed), with facts parsed; null if never met. */
    person: (id) => rowOut(canonical(id)),
    /** Meet or greet: makes the person if new, counts a talk when `talked`. Returns their row. */
    meet(id, name, { at = Date.now(), talked = true } = {}) {
      q.addPerson.run(id, String(name).slice(0, 64), at, at);
      const own = canonical(id);
      if (talked) q.touchPerson.run(at, own.id);
      else q.seenPerson.run(at, own.id);
      return rowOut(q.rawPerson.get(own.id));
    },
    /** Set how the bot feels: affinity -100..100, trust 0..100. */
    feel(id, affinity, trust) {
      const own = canonical(id);
      if (!own) return;
      q.setFeel.run(Math.max(-100, Math.min(100, Math.round(affinity))), Math.max(0, Math.min(100, Math.round(trust))), own.id);
    },
    nickname(id, nick) { const own = canonical(id); if (own) q.setNick.run(nick ? String(nick).slice(0, 32) : null, own.id); },
    /** Keep a fact about a person: the newest 20, no repeats. */
    addFact(id, fact) {
      const own = canonical(id);
      if (!own) return;
      const facts = rowOut(own).facts.filter((f) => f.toLowerCase() !== String(fact).toLowerCase());
      facts.push(String(fact).slice(0, 200));
      q.setFacts.run(JSON.stringify(facts.slice(-20)), own.id);
    },
    setFacts(id, facts) { const own = canonical(id); if (own) q.setFacts.run(JSON.stringify(facts.slice(-20)), own.id); },
    /** Make `other` an alias of `keep`: their talks, facts and memories join `keep`'s. */
    link(keep, other) {
      const a = canonical(keep);
      const b = canonical(other);
      if (!a || !b || a.id === b.id) return false;
      q.mergeStats.run(b.talks, b.first_at, b.last_at, a.id);
      const facts = [...rowOut(a).facts, ...rowOut(b).facts.filter((f) => !rowOut(a).facts.includes(f))];
      q.setFacts.run(JSON.stringify(facts.slice(-20)), a.id);
      q.moveMemories.run(a.id, b.id);
      for (const alias of q.aliases.all(b.id)) q.setLink.run(a.id, alias.id);
      q.setLink.run(a.id, b.id);
      return true;
    },
    /** Everyone the bot knows (own rows), most recently seen first, each with their aliases. */
    people: (n = 200) => q.people.all(n).map((r) => ({ ...rowOut(r), aliases: q.aliases.all(r.id) })),
    /** Own rows of people known by this name or nickname, most recently seen first. */
    peopleNamed: (name) => [...new Map(q.byName.all(name, name).map((r) => {
      const own = canonical(r.id);
      return [own.id, rowOut(own)];
    })).values()],
    forget(id) {
      const own = canonical(id);
      if (!own) return false;
      for (const alias of q.aliases.all(own.id)) q.dropMemoriesAbout.run(alias.id);
      q.dropMemoriesAbout.run(own.id);
      q.dropPerson.run(own.id, own.id);
      return true;
    },
    /** A memory: about a person (their id) or the world (null), weight 1 (passing) to 5 (unforgettable). */
    remember(about, text, weight = 2, at = Date.now(), { secret = false } = {}) {
      const own = about ? canonical(about)?.id ?? about : null;
      q.addMemory.run(at, own, String(text).slice(0, 300), Math.max(1, Math.min(5, Math.round(weight))), secret && own ? 1 : 0);
    },
    /** Memories about a person; their secrets only with `withSecrets` (when they are the one talking). */
    memoriesAbout: (id, n = 8, { withSecrets = false } = {}) => {
      const own = canonical(id);
      return own ? q.memoriesAbout.all(own.id, withSecrets ? 1 : 0, n) : [];
    },
    recentMemories: (n = 8, minWeight = 1) => q.memoriesRecent.all(minWeight, n),
    /** Memories with these words; secrets only those of `asker` (an id), when given. */
    findMemories: (text, n = 8, asker = null) => q.memoriesFind.all(`%${String(text).replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
      asker ? canonical(asker)?.id ?? asker : '', n),
    allMemories: (n = 100) => q.memoriesAll.all(n),
    /** Times this person pushed the bot out of character lately; it fades after a day of peace. */
    pressure(id, at = Date.now()) {
      const own = canonical(id);
      if (!own) return 0;
      return at - own.pressure_at > 86_400_000 ? 0 : own.pressure;
    },
    press(id, at = Date.now()) {
      const own = canonical(id);
      if (!own) return 0;
      const n = (at - own.pressure_at > 86_400_000 ? 0 : own.pressure) + 1;
      q.setPressure.run(n, at, own.id);
      return n;
    },
    dropMemory: (id) => q.dropMemory.run(id).changes > 0,
    close: () => db.close(),
  };
}
