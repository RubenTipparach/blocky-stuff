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
    close: () => db.close(),
  };
}
