// What the AI can do in the world: one list shared by the in-game bot (server/bot.mjs) and the MCP server
// (server/mcp.mjs). Each tool names the permission it needs. An admin (a player with the `server` privilege
// in game, or whoever holds the MCP token) may use every tool; other players only the ones switched on for
// them on /admin (the policy), and only on themselves.

// The first policy: what players who are not admins may ask the bot for. Changed on /admin.
export const DEFAULT_POLICY = { give: true, teleport: true, time: true, heal: true, build: false };
// Most blocks one request may place.
const BUILD_MAX = 2048;

const pos = { type: 'integer' };
const player = { type: 'string', description: 'Player name, exactly as listed by list_players.' };

export const TOOLS = [
  {
    name: 'list_players',
    description: 'The players online now: name, position (x, y up, z), health out of 20 and whether they are an admin.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: ({ game }) => ({
      ok: true,
      message: JSON.stringify({ players: game.players.map((p) => ({ ...p, admin: p.privs.includes('server'), privs: undefined })),
        time_of_day: game.time === null ? null : hours(game.time) }),
    }),
  },
  {
    name: 'find_items',
    description: 'Search the item and block names this game has (e.g. "wood", "pick diamond"). Use it before give_item '
      + 'or building, since items must be named exactly, like default:pick_diamond.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    run: ({ game }, { query }) => {
      const found = game.findItems(query);
      return { ok: true, message: found.length ? found.join(', ') : 'No items match.' };
    },
  },
  {
    name: 'find_ground',
    description: 'The ground at columns of the world: for each {x, z}, the y of the highest solid block and what it is. '
      + 'Build from y + 1. Up to 25 columns at once.',
    input_schema: {
      type: 'object',
      properties: { columns: { type: 'array', minItems: 1, maxItems: 25, items: { type: 'object',
        properties: { x: pos, z: pos }, required: ['x', 'z'], additionalProperties: false } } },
      required: ['columns'], additionalProperties: false,
    },
    run: ({ game }, { columns }) => game.act({ type: 'ground', columns: columns.slice(0, 25) }),
  },
  {
    name: 'give_item',
    permission: 'give',
    self: 'player',
    description: 'Put items in a player\'s inventory.',
    input_schema: {
      type: 'object',
      properties: { player, item: { type: 'string', description: 'Exact item name from find_items.' },
        count: { type: 'integer', minimum: 1, maximum: 99 } },
      required: ['player', 'item'], additionalProperties: false,
    },
    run: ({ game }, { player: name, item, count = 1 }) => game.act({ type: 'give', player: name, item,
      count: clamp(count, 1, 99) }),
  },
  {
    name: 'teleport_player',
    permission: 'teleport',
    self: 'player',
    description: 'Move a player to a position. y is up; sea level is about 0, and y 10 above the ground is safe.',
    input_schema: {
      type: 'object', properties: { player, x: pos, y: pos, z: pos }, required: ['player', 'x', 'y', 'z'],
      additionalProperties: false,
    },
    run: ({ game }, { player: name, x, y, z }) => game.act({ type: 'teleport', player: name, x, y, z }),
  },
  {
    name: 'heal_player',
    permission: 'heal',
    self: 'player',
    description: 'Restore a player to full health.',
    input_schema: { type: 'object', properties: { player }, required: ['player'], additionalProperties: false },
    run: ({ game }, { player: name }) => game.act({ type: 'heal', player: name }),
  },
  {
    name: 'set_time',
    permission: 'time',
    description: 'Set the time of day for everyone, in hours: 6 is sunrise, 12 noon, 19 dusk, 0 midnight.',
    input_schema: { type: 'object', properties: { hour: { type: 'number', minimum: 0, maximum: 24 } }, required: ['hour'],
      additionalProperties: false },
    run: ({ game }, { hour }) => game.act({ type: 'time', value: (clamp(hour, 0, 24) % 24) / 24 }),
  },
  {
    name: 'fill_box',
    permission: 'build',
    description: `Fill the box between two corners with one block (air removes blocks), solid or as hollow walls. At most ${BUILD_MAX} blocks.`,
    input_schema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'Exact block name from find_items, or air.' },
        x1: pos, y1: pos, z1: pos, x2: pos, y2: pos, z2: pos,
        hollow: { type: 'boolean', description: 'Only the outer shell.' },
      },
      required: ['item', 'x1', 'y1', 'z1', 'x2', 'y2', 'z2'], additionalProperties: false,
    },
    run: ({ game }, b) => {
      const nodes = boxNodes(b);
      if (!nodes) return { ok: false, message: `That box is more than ${BUILD_MAX} blocks: build it in parts.` };
      return game.act({ type: 'place', nodes });
    },
  },
  {
    name: 'place_blocks',
    permission: 'build',
    description: `Place single blocks: a list of {x, y, z, item}. For shapes a box cannot make. At most ${BUILD_MAX}.`,
    input_schema: {
      type: 'object',
      properties: {
        blocks: {
          type: 'array', maxItems: BUILD_MAX,
          items: { type: 'object', properties: { x: pos, y: pos, z: pos, item: { type: 'string' } },
            required: ['x', 'y', 'z', 'item'], additionalProperties: false },
        },
      },
      required: ['blocks'], additionalProperties: false,
    },
    run: ({ game }, { blocks }) => game.act({ type: 'place', nodes: blocks.slice(0, BUILD_MAX) }),
  },
  {
    name: 'walk_to',
    permission: 'admin',
    description: 'Walk your body in the world to a spot and stand there a while (to look at something, or join someone).',
    input_schema: { type: 'object', properties: { x: pos, y: pos, z: pos }, required: ['x', 'y', 'z'], additionalProperties: false },
    run: ({ game }, { x, y, z }) => game.act({ type: 'walk', x, y, z }),
  },
  {
    name: 'kick_player',
    permission: 'admin',
    description: 'Disconnect a player from the server.',
    input_schema: { type: 'object', properties: { player, reason: { type: 'string' } }, required: ['player'],
      additionalProperties: false },
    run: ({ game }, { player: name, reason }) => game.act({ type: 'kick', player: name, reason }),
  },
];

/**
 * The tools `asker` may use. asker: { name, admin }, policy: DEFAULT_POLICY's shape.
 */
export function toolsFor(asker, policy = DEFAULT_POLICY) {
  return TOOLS.filter((t) => !t.permission || asker.admin || (t.permission !== 'admin' && policy[t.permission]));
}

/** Run a tool for `asker`, checking again that they may. Returns { ok, message }. */
export async function runTool(name, input, { game, asker, policy = DEFAULT_POLICY }) {
  const tool = toolsFor(asker, policy).find((t) => t.name === name);
  if (!tool) return { ok: false, message: `${asker.name} may not use ${name}.` };
  if (tool.self && !asker.admin && String(input?.[tool.self] ?? '').toLowerCase() !== asker.name.toLowerCase()) {
    return { ok: false, message: `Only admins may use ${name} on other players; ${asker.name} may use it on themselves.` };
  }
  try {
    return await tool.run({ game, asker }, input ?? {});
  } catch (err) {
    return { ok: false, message: `${name} failed: ${err.message}` };
  }
}

/** The blocks of a box, or null when there are too many. */
export function boxNodes({ item, x1, y1, z1, x2, y2, z2, hollow = false }) {
  const [ax, bx] = [Math.min(x1, x2), Math.max(x1, x2)];
  const [ay, by] = [Math.min(y1, y2), Math.max(y1, y2)];
  const [az, bz] = [Math.min(z1, z2), Math.max(z1, z2)];
  const total = (bx - ax + 1) * (by - ay + 1) * (bz - az + 1);
  if (!hollow && total > BUILD_MAX) return null;
  const nodes = [];
  for (let x = ax; x <= bx; x++) {
    for (let y = ay; y <= by; y++) {
      for (let z = az; z <= bz; z++) {
        const edge = x === ax || x === bx || y === ay || y === by || z === az || z === bz;
        if (hollow && !edge) continue;
        if (nodes.length >= BUILD_MAX) return null;
        nodes.push({ x, y, z, item });
      }
    }
  }
  return nodes;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || lo));
const hours = (t) => Math.round(t * 24 * 10) / 10;
