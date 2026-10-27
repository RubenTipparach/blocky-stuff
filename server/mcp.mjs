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
