// An MCP server at POST /mcp, so Claude Code, Claude Desktop or any MCP client can run the world: see who is
// on, read and send chat, give, teleport, build. The tools are the bot's (server/tools.mjs), used as an admin,
// plus a few for the operator. The Streamable HTTP transport, answering with plain JSON (no streams, no
// sessions); the caller sends `Authorization: Bearer <token>`, the token made on /admin (or MCP_TOKEN).
//
//   claude mcp add --transport http blocky https://blocky-stuff.fly.dev/mcp --header "Authorization: Bearer <token>"

import { createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS, runTool } from './tools.mjs';

const REPO = process.env.REPO || 'RubenTipparach/blocky-stuff';
// What a hot update may change: the bot's code, tests and notes. The launcher, Luanti's runner, hotdeploy itself, the
// mod, the image and the dependencies need a full deploy, which a merge into main makes.
const HOT_OK = (f) => /^(server\/|tests\/|docs\/)|\.md$/.test(f) && !/^server\/(launcher|luanti|hotdeploy)\.mjs$/.test(f);

/**
 * Put a pushed commit's bot code live (owner, 2026-10-27: "I want you to be able to update mjs [from the] mcp server,
 * but only if a git commit was made also"): GitHub must have the commit, and everything it changes since the live
 * code must be hot-updatable. server/hotdeploy.mjs does the rest, in its own process, once this answer is sent.
 */
async function deployBotCode({ sha }) {
  if (!/^[0-9a-f]{7,40}$/.test(String(sha ?? ''))) return { ok: false, message: 'Give the commit sha (7 to 40 hex characters).' };
  if (!process.env.SUPERVISED) return { ok: false, message: 'This server is not run by the launcher: it cannot update the bot alone.' };
  const live = process.env.BOT_SHA || process.env.GIT_SHA || '';
  if (!/^[0-9a-f]{7,40}$/.test(live)) return { ok: false, message: 'The live commit is unknown: deploy by merging into main.' };
  const res = await fetch(`https://api.github.com/repos/${REPO}/compare/${live}...${sha}`,
    { headers: { 'user-agent': 'blocky-stuff', accept: 'application/vnd.github+json' } }).catch(() => null);
  if (!res?.ok) return { ok: false, message: `GitHub does not have ${sha} (${res?.status ?? 'no answer'}): commit and push it first.` };
  const cmp = await res.json();
  const head = cmp.commits?.at(-1)?.sha;
  if (!head || cmp.status === 'identical') return { ok: false, message: `${sha} is what is live already.` };
  if (cmp.status === 'behind') return { ok: false, message: `${sha} is older than the live code.` };
  const files = (cmp.files ?? []).map((f) => f.filename);
  const full = files.filter((f) => !HOT_OK(f));
  if (full.length) return { ok: false, message: `These need a full deploy (merge into main): ${full.slice(0, 10).join(', ')}.` };
  const image = process.env.IMAGE_DIR || join(dirname(fileURLToPath(import.meta.url)), '..');
  setTimeout(() => {
    const out = openSync(join(process.env.DATA_DIR || '/data', 'app', 'hotdeploy.log'), 'a');
    spawn(process.execPath, [join(image, 'server', 'hotdeploy.mjs'), head], { cwd: image, detached: true, stdio: ['ignore', out, out] }).unref();
  }, 300);
  return { ok: true, message: `Deploying ${head.slice(0, 7)} (${files.length} files since ${live.slice(0, 7)}): the bot restarts in a few `
    + 'seconds, the game keeps running. server_status (or GET /api/version) shows the live commit.' };
}

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
    name: 'deploy_bot_code',
    description: 'Put a commit\'s bot code live without restarting the game. The commit must be pushed to GitHub, and '
      + 'change only bot code (server/, not the launcher, luanti.mjs or hotdeploy.mjs), tests or docs since the live '
      + 'code; anything else deploys by merging into main.',
    input_schema: { type: 'object', properties: { sha: { type: 'string' } }, required: ['sha'], additionalProperties: false },
    run: (ctx, args) => deployBotCode(args),
  },
  {
    name: 'restart_game',
    description: 'Restart the Luanti game server (the bot stays up). Refused while anyone is playing, unless force.',
    input_schema: { type: 'object', properties: { force: { type: 'boolean' } }, additionalProperties: false },
    run: ({ restartGame }, args) => restartGame(args),
  },
  {
    name: 'talk_to_character',
    description: 'Say something to one character, as the server\'s builders (an admin), and get her answer; she answers '
      + 'in the game and on Discord as usual. For news ("doors work now"), instructions or questions.',
    input_schema: { type: 'object', properties: { name: { type: 'string' }, text: { type: 'string', maxLength: 600 } },
      required: ['name', 'text'], additionalProperties: false },
    run: async ({ talk }, { name, text }) => talk(name, text),
  },
  // ---- The map (owner, 2026-10-27: "Check the mcp server, does it have map controls?") ----
  {
    name: 'map_status',
    description: 'How fresh the map is: how many 64-block chunks it keeps, when each was last read from the game, which '
      + 'are waiting for the next 5-minute update, and when that last ran.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: ({ maps }) => ({ ok: true, message: JSON.stringify(maps.storeStatus(), null, 1) }),
  },
  {
    name: 'refresh_map',
    description: 'Read an area of the world into the map again now (the chunks under columns x1, z1 to x2, z2; at most '
      + '16 chunks of 64 by 64), so the map and pictures show it as it is.',
    input_schema: { type: 'object', properties: { x1: { type: 'integer' }, z1: { type: 'integer' }, x2: { type: 'integer' },
      z2: { type: 'integer' } }, required: ['x1', 'z1', 'x2', 'z2'], additionalProperties: false },
    run: async ({ maps, game }, { x1, z1, x2, z2 }) => {
      if (!game.connected) return { ok: false, message: 'The game is not running.' };
      const read = await maps.refresh(x1, z1, x2, z2);
      return { ok: true, message: `Read ${read.length} chunks again: ${read.join('; ') || 'none'}.` };
    },
  },
  {
    name: 'map_picture',
    description: 'An isometric picture of the world around (x, z), r blocks each way (8 to 64), from the map (refresh_map '
      + 'first for the very latest). y: about the ground there, to see deeper or higher.',
    input_schema: { type: 'object', properties: { x: { type: 'integer' }, z: { type: 'integer' }, y: { type: 'integer' },
      r: { type: 'integer', minimum: 8, maximum: 64 } }, required: ['x', 'z'], additionalProperties: false },
    run: async ({ maps }, { x, z, y = null, r = 32 }) => {
      const out = await maps.render({ x, z, y, r });
      if (out.error) return { ok: false, message: out.error };
      return { ok: true, message: `Around ${x}, ${z}, ${r} blocks each way.`, image: out.png.toString('base64') };
    },
  },
  {
    name: 'tool_requests',
    description: 'What the characters asked to be able to do that their tools cannot (request_tool), most asked first; '
      + 'done ones last. Mark one done (or declined) with resolve, its id and a note.',
    input_schema: { type: 'object', properties: { resolve: { type: 'integer' }, note: { type: 'string', maxLength: 200 } },
      additionalProperties: false },
    run: ({ db }, { resolve, note }) => {
      const list = db.json('tool.requests', []);
      if (resolve) {
        const r = list.find((x) => x.id === resolve);
        if (!r) return { ok: false, message: `No request ${resolve}.` };
        r.done = { at: Date.now(), note: String(note ?? 'done') };
        db.putJson('tool.requests', list);
        return { ok: true, message: `Request ${resolve} marked: ${r.done.note}.` };
      }
      const open = list.filter((r) => !r.done).sort((a, b) => b.count - a.count);
      return { ok: true, message: JSON.stringify({ open, done: list.filter((r) => r.done).slice(-20) }, null, 1) };
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
      return reply({ content: [{ type: 'text', text: r.message || (r.ok ? 'Done.' : 'Failed.') },
        ...(r.image ? [{ type: 'image', data: r.image, mimeType: 'image/png' }] : [])], isError: !r.ok });
    }
    default:
      return fail(-32601, `Method ${msg.method} is not offered.`);
  }
}
