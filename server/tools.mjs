// What the AI can do in the world: one list shared by the in-game bot (server/bot.mjs) and the MCP server
// (server/mcp.mjs). Each tool names the permission it needs. An admin (a player with the `server` privilege
// in game, or whoever holds the MCP token) may use every tool; other players only the ones switched on for
// them on /admin (the policy), and only on themselves.

// The first policy: what players who are not admins may ask the bot for. Changed on /admin.
export const DEFAULT_POLICY = { give: true, teleport: true, time: true, heal: true, build: false };
// Most blocks one request may place.
const BUILD_MAX = 2048;
// Most blocks one fill_box may set (done in one go in the game; owner, 2026-10-27: "expand it to something like 100,000").
const BOX_MAX = 100_000;

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
    name: 'inspect_area',
    description: 'Look at the real blocks in a box (at most 24 by 24 columns and 16 high), to check a build before saying it '
      + 'is done: a legend of letters for the blocks, then each layer from the top down as rows of x (west to east), one '
      + 'row per z (north to south), "." for air; and how many of each block.',
    input_schema: {
      type: 'object',
      properties: { x1: pos, y1: pos, z1: pos, x2: pos, y2: pos, z2: pos },
      required: ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'], additionalProperties: false,
    },
    run: async ({ game }, b) => {
      const [ax, bx] = [Math.min(b.x1, b.x2), Math.max(b.x1, b.x2)];
      const [ay, by] = [Math.min(b.y1, b.y2), Math.max(b.y1, b.y2)];
      const [az, bz] = [Math.min(b.z1, b.z2), Math.max(b.z1, b.z2)];
      if (bx - ax >= 24 || bz - az >= 24 || by - ay >= 16) return { ok: false, message: 'Too big: at most 24 by 24 columns and 16 high.' };
      const r = await game.act({ type: 'scan', runs: true, x1: ax, z1: az, w: bx - ax + 1, d: bz - az + 1, y1: ay, y2: by });
      if (!r.ok) return r;
      return { ok: true, message: describeArea(JSON.parse(r.message), { ax, ay, az, bx, by, bz }) };
    },
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
    description: `Fill the box between two corners with one block (air removes blocks), solid or as hollow walls. At most ${BOX_MAX} blocks `
      + '(say 46 by 46 by 46). To take away trees or flatten ground, use clear_area instead.',
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
      if (boxCount(b) > BOX_MAX) return { ok: false, message: `That box is more than ${BOX_MAX} blocks: build it in parts.` };
      return game.act({ type: 'box', item: b.item, x1: b.x1, y1: b.y1, z1: b.z1, x2: b.x2, y2: b.y2, z2: b.z2, hollow: b.hollow === true });
    },
  },
  {
    name: 'clear_area',
    permission: 'build',
    description: 'Big groundwork, up to 100,000 columns at once (say 316 by 316). mode "trees": take away the trees, leaves, grass, '
      + 'flowers, bushes and snow cover of an area, leaving the ground as it is (give y, about the ground there, if you '
      + 'know it). mode "level": make the ground flat at height y: everything above it goes (hills are cut down), the '
      + 'gaps below are filled (up to 16 deep), and the top becomes `surface` (default dirt with grass). Levelling '
      + 'refuses to cut into any build. Then build from y + 1.',
    input_schema: {
      type: 'object',
      properties: { x1: pos, z1: pos, x2: pos, z2: pos, mode: { type: 'string', enum: ['trees', 'level'] }, y: pos,
        surface: { type: 'string', description: 'Top block for "level", e.g. default:dirt_with_grass, default:stone.' },
        fill: { type: 'string', description: 'What fills gaps under it, e.g. default:dirt.' } },
      required: ['x1', 'z1', 'x2', 'z2', 'mode'], additionalProperties: false,
    },
    run: ({ game }, c) => game.act({ type: 'clear', x1: c.x1, z1: c.z1, x2: c.x2, z2: c.z2, mode: c.mode,
      ...(Number.isFinite(c.y) ? { y: c.y } : {}), ...(c.surface ? { surface: c.surface } : {}), ...(c.fill ? { fill: c.fill } : {}) }),
  },
  // Farming (Minetest Game's: wheat and cotton). Seeds set with place_blocks grow too, on wet soil near water.
  {
    name: 'farm',
    permission: 'build',
    description: 'Make a field: till the ground of an area (x1, z1 to x2, z2; at most 16 by 16) into wet soil and sow it '
      + 'with wheat or cotton, digging water channels where there is no water within 3 blocks (crops need it). The ground '
      + 'must be dirt, grass or similar. Crops ripen in about 25 to 40 minutes in daylight; then use harvest. Wheat makes '
      + 'flour and bread (crafted), cotton makes string and wool. A fence around the field keeps it tidy.',
    input_schema: {
      type: 'object',
      properties: { x1: pos, z1: pos, x2: pos, z2: pos, crop: { type: 'string', enum: ['wheat', 'cotton'] },
        water: { type: 'boolean', description: 'Dig water channels if needed (default true).' } },
      required: ['x1', 'z1', 'x2', 'z2'], additionalProperties: false,
    },
    run: ({ game }, f) => game.act({ type: 'farm', x1: f.x1, z1: f.z1, x2: f.x2, z2: f.z2, crop: f.crop ?? 'wheat', water: f.water !== false }),
  },
  {
    name: 'harvest',
    permission: 'build',
    description: 'Gather the ripe crops of a field (its corners, and y about the ground\'s height), sow it again, and give '
      + 'the harvest to a player (or leave it on the field). Says how many are still growing.',
    input_schema: {
      type: 'object',
      properties: { x1: pos, z1: pos, x2: pos, z2: pos, y: pos, player: { type: 'string', description: 'Who gets the harvest.' } },
      required: ['x1', 'z1', 'x2', 'z2', 'y'], additionalProperties: false,
    },
    run: ({ game }, f) => game.act({ type: 'harvest', x1: f.x1, z1: f.z1, x2: f.x2, z2: f.z2, y: f.y, ...(f.player ? { player: f.player } : {}) }),
  },
  {
    name: 'place_blocks',
    permission: 'build',
    description: `Place single blocks: a list of {x, y, z, item}, with facing for blocks that turn: stairs rise toward it `
      + '(upside_down: hang from it, for eaves and arches), a door looks out toward it (a door is placed with its '
      + 'lower block; doors:door_wood, door_glass...), a torch, ladder or sign hangs on that side\'s wall. North is +z, '
      + `east +x. For details a box cannot make: window frames, trims, steps, furniture. At most ${BUILD_MAX}.`,
    input_schema: {
      type: 'object',
      properties: {
        blocks: {
          type: 'array', maxItems: BUILD_MAX,
          items: { type: 'object', properties: { x: pos, y: pos, z: pos, item: { type: 'string' },
            facing: { type: 'string', enum: ['north', 'east', 'south', 'west'] }, upside_down: { type: 'boolean' } },
          required: ['x', 'y', 'z', 'item'], additionalProperties: false },
        },
      },
      required: ['blocks'], additionalProperties: false,
    },
    run: ({ game }, { blocks }) => game.act({ type: 'place', nodes: blocks.slice(0, BUILD_MAX) }),
  },
  {
    name: 'build_roof',
    permission: 'build',
    description: 'A proper roof over walls whose outer corners are x1, z1 and x2, z2, starting at height y (one above '
      + 'the wall tops). style "gable": two slopes of stairs meeting at a ridge, the ends closed with `gable` blocks; '
      + '"hip": four slopes rising to a ridge or point; "flat": a slab deck with a raised rim. overhang: how far the '
      + 'eaves stick out (default 1). Stairs like stairs:stair_wood, stair_pine_wood, stair_junglewood, '
      + 'stair_acacia_wood, stair_brick, stair_stonebrick, stair_cobble, stair_desert_stonebrick (find_items "stair").',
    input_schema: {
      type: 'object',
      properties: { x1: pos, z1: pos, x2: pos, z2: pos, y: pos, style: { type: 'string', enum: ['gable', 'hip', 'flat'] },
        stairs: { type: 'string' }, gable: { type: 'string', description: 'Block for the gable ends (default: the walls\' look, wood).' },
        ridge_along: { type: 'string', enum: ['x', 'z'], description: 'Which way the ridge runs (default: the longer side).' },
        overhang: { type: 'integer', minimum: 0, maximum: 2 } },
      required: ['x1', 'z1', 'x2', 'z2', 'y', 'stairs'], additionalProperties: false,
    },
    run: ({ game }, r) => {
      const nodes = roofNodes(r);
      if (!nodes.length) return { ok: false, message: 'That roof has no size.' };
      if (nodes.length > ROOF_MAX) return { ok: false, message: `That roof is over ${ROOF_MAX} blocks: roof the house in parts.` };
      return game.act({ type: 'place', nodes });
    },
  },
  {
    name: 'follow_player',
    self: 'player',
    description: 'Start following a player around with your body, until they ask you to stop (stay_put). Only when '
      + 'they ask you to follow them, or come along.',
    input_schema: { type: 'object', properties: { player }, required: ['player'], additionalProperties: false },
    run: ({ game }, { player: name }) => game.act({ type: 'follow', player: name }),
  },
  {
    name: 'come_to',
    self: 'player',
    description: 'Walk over to a player once and stay there (when they say come here, or want you near).',
    input_schema: { type: 'object', properties: { player }, required: ['player'], additionalProperties: false },
    run: ({ game }, { player: name }) => game.act({ type: 'come', player: name }),
  },
  {
    name: 'stay_put',
    description: 'Stop following anyone and stay where you are.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: ({ game }) => game.act({ type: 'stay' }),
  },
  {
    name: 'walk_to',
    description: 'Walk your body in the world to a spot and stay there (to look at something, or to go somewhere asked).',
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

/** A scan (runs) of a box as text: a legend, each layer with anything in it top down, and the counts. */
export function describeArea(scan, { ax, ay, az, bx, by, bz }) {
  const w = bx - ax + 1;
  const names = Array.isArray(scan.names) ? scan.names : [];
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const grid = new Map(); // "x,y,z" -> name index
  (scan.cols ?? []).forEach((col, i) => {
    const x = ax + (i % w);
    const z = az + Math.floor(i / w);
    for (let k = 0; col && k + 2 < col.length; k += 3) for (let y = col[k]; y > col[k] - col[k + 1]; y--) grid.set(`${x},${y},${z}`, col[k + 2]);
  });
  const counts = new Map();
  for (const id of grid.values()) counts.set(id, (counts.get(id) ?? 0) + 1);
  const legend = [...counts.keys()].map((id, i) => [id, letters[i] ?? '?']);
  const letterOf = new Map(legend);
  const layers = [];
  for (let y = by; y >= ay; y--) {
    const rows = [];
    let any = false;
    for (let z = az; z <= bz; z++) {
      let row = '';
      for (let x = ax; x <= bx; x++) {
        const id = grid.get(`${x},${y},${z}`);
        if (id !== undefined) any = true;
        row += id === undefined ? '.' : letterOf.get(id);
      }
      rows.push(row);
    }
    if (any) layers.push(`y=${y} (rows z=${az}..${bz}, columns x=${ax}..${bx}):\n${rows.join('\n')}`);
  }
  if (!layers.length) return `Nothing but air from (${ax}, ${ay}, ${az}) to (${bx}, ${by}, ${bz}).`;
  return `Legend: ${legend.map(([id, l]) => `${l}=${names[id]}`).join(', ')}\n`
    + `Counts: ${legend.map(([id]) => `${names[id]} ${counts.get(id)}`).join(', ')}\n${layers.join('\n')}`;
}

/** The blocks of a box, or null when there are too many. */
const ROOF_MAX = 8000;
/**
 * The blocks of a roof (owner, 2026-10-27: "A lot of the houses are lacking in style"): stairs rising from the eaves
 * to a ridge, each course one in and one up; a gable's ends filled to the slope; a slab ridge where an odd width
 * leaves one row; a hip's four sides; or a flat slab deck with a rim of stairs.
 */
export function roofNodes({ x1, z1, x2, z2, y, style = 'gable', stairs, gable, ridge_along: along, overhang = 1 }) {
  const o = Math.max(0, Math.min(2, Math.round(overhang)));
  const [ax, bx] = [Math.min(x1, x2) - o, Math.max(x1, x2) + o];
  const [az, bz] = [Math.min(z1, z2) - o, Math.max(z1, z2) + o];
  const slab = String(stairs).replace(/stairs:stair_(inner_|outer_)?/, 'stairs:slab_');
  const fill = gable || String(stairs).replace(/stairs:stair_(inner_|outer_)?/, 'default:');
  const nodes = [];
  const put = (x, yy, z, item, facing) => nodes.push({ x, y: yy, z, item, ...(facing ? { facing } : {}) });
  if (style === 'flat') {
    for (let x = ax; x <= bx; x++) for (let z = az; z <= bz; z++) {
      const rim = x === ax || x === bx || z === az || z === bz;
      put(x, y, z, rim ? stairs : slab, rim ? (z === az ? 'north' : z === bz ? 'south' : x === ax ? 'east' : 'west') : null);
    }
    return nodes;
  }
  const alongX = along ? along === 'x' : bx - ax >= bz - az;
  if (style === 'hip') {
    for (let k = 0; ; k++) {
      const [lx, rx, lz, rz] = [ax + k, bx - k, az + k, bz - k];
      if (lx > rx || lz > rz) break;
      if (lx === rx || lz === rz) { for (let x = lx; x <= rx; x++) for (let z = lz; z <= rz; z++) put(x, y + k, z, slab); break; }
      for (let x = lx; x <= rx; x++) { put(x, y + k, lz, stairs, 'north'); put(x, y + k, rz, stairs, 'south'); }
      for (let z = lz + 1; z < rz; z++) { put(lx, y + k, z, stairs, 'east'); put(rx, y + k, z, stairs, 'west'); }
    }
    return nodes;
  }
  // Gable: the slopes rise across the short way; the walls under the two ends are closed up to the roof.
  const [wl, wr] = alongX ? [Math.min(x1, x2), Math.max(x1, x2)] : [Math.min(z1, z2), Math.max(z1, z2)];
  const [lo, hi] = alongX ? [az, bz] : [ax, bx];
  const [s0, s1] = alongX ? [ax, bx] : [az, bz];
  for (let k = 0; ; k++) {
    const [l, r] = [lo + k, hi - k];
    if (l > r) break;
    for (let s = s0; s <= s1; s++) {
      const at = (c, item, facing) => (alongX ? put(s, y + k, c, item, facing) : put(c, y + k, s, item, facing));
      if (l === r) { at(l, slab); continue; }
      at(l, stairs, alongX ? 'north' : 'east');
      at(r, stairs, alongX ? 'south' : 'west');
      if (s === wl || s === wr) for (let c = l + 1; c < r; c++) at(c, fill);
    }
  }
  return nodes;
}

/** How many blocks a fill_box sets. */
export function boxCount({ x1, y1, z1, x2, y2, z2, hollow = false }) {
  const [a, b, c] = [Math.abs(x2 - x1) + 1, Math.abs(y2 - y1) + 1, Math.abs(z2 - z1) + 1];
  return hollow ? a * b * c - Math.max(0, a - 2) * Math.max(0, b - 2) * Math.max(0, c - 2) : a * b * c;
}

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
