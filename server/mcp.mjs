// An MCP server at POST /mcp, so Claude Code, Claude Desktop or any MCP client can run the world: see who is
// on, read and send chat, give, teleport, build. The tools are the bot's (server/tools.mjs), used as an admin,
// plus a few for the operator. The Streamable HTTP transport, answering with plain JSON (no streams, no
// sessions); the caller sends `Authorization: Bearer <token>`, the token made on /admin (or MCP_TOKEN).
//
//   claude mcp add --transport http blocky https://blocky-stuff.fly.dev/mcp --header "Authorization: Bearer <token>"

import { createHash, timingSafeEqual } from 'node:crypto';
import { TOOLS, runTool } from './tools.mjs';

const LATEST = '2025-11-25';

// For the operator only: not offered to players.
const OPERATOR_TOOLS = [
  {
    name: 'server_status',
    description: 'Whether the game server is up, its address, who is online and the bot\'s state.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: ({ status }) => ({ ok: true, message: JSON.stringify(status()) }),
  },
  {
    name: 'recent_chat',
    description: 'The latest chat lines, from the game, Discord and the bot, oldest first.',
    input_schema: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 200 } },
      additionalProperties: false },
    run: ({ db }, { count = 30 }) => ({ ok: true, message: db.chat(Math.min(200, Math.max(1, count)))
      .map((c) => `${new Date(c.at).toISOString()} [${c.source}] ${c.name}: ${c.text}`).join('\n') || '(no chat yet)' }),
  },
  // ---- Looking into what the characters heard and did (owner, 2026-10-27: "build some tools to let you access and
  // analyze messages") ----
  {
    name: 'activity_log',
    description: 'The characters\' Activity log, newest first (kept 30 days): what they heard and answered, what they '
      + 'skipped and why, their own turns, tasks, errors. Page back with before (the last id you got). kind: answered, '
      + 'quiet, skipped, ignored, limited, error, own turn, task, prank.',
    input_schema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 500 }, before: { type: 'integer' },
      kind: { type: 'string' }, character: { type: 'string' }, words: { type: 'string', description: 'All must appear.' },
      hours: { type: 'number', description: 'Only the last this many hours.' } }, additionalProperties: false },
    run: ({ db }, a) => {
      const rows = db.activity({ before: a.before ?? null, kinds: a.kind ? [a.kind] : null, character: a.character ?? null,
        words: a.words ?? '', since: a.hours ? Date.now() - a.hours * 3_600_000 : 0, limit: a.limit ?? 50 });
      return { ok: true, message: rows.map((e) => `#${e.id} ${new Date(e.at).toISOString()} [${e.kind}] ${e.character ?? '-'}`
        + `${e.who ? ` (${e.who})` : ''}: ${e.text}`).join('\n') || '(nothing)' };
    },
  },
  {
    name: 'search_chat',
    description: 'Search the chat log (game, Discord and the characters\' lines; the newest 20,000 are kept), newest '
      + 'first. Filter by words (all must appear), name, source (game, discord, bot, admin) and the last hours; page '
      + 'back with before (the last id you got).',
    input_schema: { type: 'object', properties: { words: { type: 'string' }, name: { type: 'string' },
      source: { type: 'string', enum: ['game', 'discord', 'bot', 'admin'] }, hours: { type: 'number' }, before: { type: 'integer' },
      limit: { type: 'integer', minimum: 1, maximum: 500 } }, additionalProperties: false },
    run: ({ db }, a) => {
      const rows = db.searchChat({ words: a.words ?? '', name: a.name ?? null, source: a.source ?? null, before: a.before ?? null,
        since: a.hours ? Date.now() - a.hours * 3_600_000 : 0, limit: a.limit ?? 50 });
      return { ok: true, message: rows.map((c) => `#${c.id} ${new Date(c.at).toISOString()} [${c.source}] ${c.name}: ${c.text}`).join('\n') || '(nothing)' };
    },
  },
  {
    name: 'activity_summary',
    description: 'An overview of the last hours: per character, how many messages she answered, skipped, stayed quiet '
      + 'on, failed, and her own turns; the most common reasons for skipping; the latest errors; AI calls and tokens a '
      + 'day; each character\'s mood, project and open task.',
    input_schema: { type: 'object', properties: { hours: { type: 'number', minimum: 1, maximum: 720 } }, additionalProperties: false },
    run: ({ db }, { hours = 24 }) => {
      const since = Date.now() - hours * 3_600_000;
      const counts = {};
      for (const r of db.activityCounts(since)) (counts[r.character ?? '(nobody)'] ??= {})[r.kind] = r.n;
      const skips = {};
      for (const e of db.activity({ kinds: ['skipped', 'ignored'], since, limit: 500 })) {
        const why = String(e.text).split('": ').pop();
        skips[why] = (skips[why] ?? 0) + 1;
      }
      const errors = db.activity({ kinds: ['error', 'limited'], since, limit: 10 });
      const cast = db.json('characters', []).map((c) => ({ name: c.name, enabled: c.enabled !== false, mood: c.mood?.label ?? null,
        project: c.project ? `${c.project.title} (${c.project.done}/${c.project.steps.length})${(c.project.crew?.length ?? 0) > 1 ? ` with ${c.project.crew.map((m) => m.name).join(', ')}` : ''}` : null,
        openTask: (c.tasks ?? []).find((t) => t.status === 'open')?.goal ?? null }));
      return { ok: true, message: JSON.stringify({ hours, perCharacter: counts,
        topSkipReasons: Object.entries(skips).sort((x, y) => y[1] - x[1]).slice(0, 10),
        recentErrors: errors.map((e) => `${new Date(e.at).toISOString()} ${e.character ?? ''}: ${e.text}`),
        usage: db.usage(Math.ceil(hours / 24) + 1), characters: cast }, null, 1) };
    },
  },
  {
    name: 'character_state',
    description: 'One character in full: settings, mood, goal, project, tasks, her latest memories, and how she feels '
      + 'about each person (affinity, trust, status).',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
    run: ({ db }, { name }) => {
      const c = db.json('characters', []).find((x) => x.name.toLowerCase() === String(name).toLowerCase() || x.id === name);
      if (!c) return { ok: false, message: `No character called ${name}.` };
      const people = db.people().map((p) => ({ name: p.name, ...db.bond(c.id, p.id) }))
        .filter((b) => b.affinity || b.trust || b.status !== 'none')
        .map((b) => ({ name: b.name, affinity: b.affinity, trust: b.trust, status: b.status, nickname: b.nickname || undefined }));
      return { ok: true, message: JSON.stringify({ ...c, memories: db.recentMemories(c.id, 25).map((m) => m.text), people }, null, 1) };
    },
  },
  {
    name: 'announce',
    description: 'Say something in the game chat (and the Discord channel), as the server.',
    input_schema: { type: 'object', properties: { text: { type: 'string', maxLength: 400 } }, required: ['text'],
      additionalProperties: false },
    run: ({ announce }, { text }) => announce(text),
  },
];

const hashToken = (t) => createHash('sha256').update(String(t)).digest();

/** True when the request's bearer token is the MCP token (MCP_TOKEN, or the hash kept by /admin). */
export function mcpAuthorized(req, { config, db }) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  if (!m) return false;
  const got = hashToken(m[1].trim());
  const wants = [config.mcpToken ? hashToken(config.mcpToken) : null,
    db.setting('mcp.token') ? Buffer.from(db.setting('mcp.token'), 'base64url') : null].filter(Boolean);
  return wants.some((w) => w.length === got.length && timingSafeEqual(w, got));
}

/** Keep a new token's hash (the token itself is shown once on /admin). */
export const storeMcpToken = (db, token) => db.putSetting('mcp.token', hashToken(token).toString('base64url'));

/**
 * One JSON-RPC message. ctx: { game, db, status(), announce(text) }. Returns the response, or null for a
 * notification.
 */
export async function mcpCall(msg, ctx) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code, message } });
  if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Not a JSON-RPC 2.0 request.');
  if (msg.id === undefined) return null; // notifications/initialized and the like
  const all = [...TOOLS, ...OPERATOR_TOOLS];
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: /^\d{4}-\d{2}-\d{2}$/.test(asked ?? '') ? asked : LATEST,
        capabilities: { tools: {} },
        serverInfo: { name: 'blocky-stuff', version: '0.1.0' },
        instructions: 'Tools for a live Luanti (voxel sandbox) server. Use list_players and find_items before acting; '
          + 'positions are x, y (up), z.',
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: all.map(({ name, description, input_schema: inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const { name, arguments: args = {} } = msg.params ?? {};
      const op = OPERATOR_TOOLS.find((t) => t.name === name);
      let r;
      if (op) r = await op.run(ctx, args);
      else if (TOOLS.some((t) => t.name === name)) {
        r = await runTool(name, args, { game: ctx.game, asker: { name: 'MCP', admin: true } });
        if (r.ok && TOOLS.find((t) => t.name === name)?.permission) ctx.db.addDeed('MCP', name, args, r.message);
      } else return fail(-32602, `Unknown tool ${name}.`);
      return reply({ content: [{ type: 'text', text: r.message || (r.ok ? 'Done.' : 'Failed.') }], isError: !r.ok });
    }
    default:
      return fail(-32601, `Method ${msg.method} is not offered.`);
  }
}
