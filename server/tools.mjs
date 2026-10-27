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
// The roof shapes build_roof makes (roofNodes below).
export const ROOF_STYLES = ['gable', 'hip', 'pyramid', 'shed', 'gambrel', 'dome', 'cone', 'castle', 'flat'];

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
    run: ({ game }, { blocks }) => game.act({ type: 'place', nodes: withDoors(blocks.slice(0, BUILD_MAX)) }),
  },
  {
    name: 'build_roof',
    permission: 'build',
    description: 'A real roof over walls whose outer corners are x1, z1 and x2, z2, starting at height y (one above the wall '
      + 'tops). Shapes: "gable" (two slopes to a ridge, a prism: cottages), "hip" (four slopes: ranch houses), "pyramid" '
      + '(four slopes to a point, over a square: towers, pavilions), "shed" (one slope rising toward high: sheds, '
      + 'porches, modern), "gambrel" (a barn roof: steep, then shallow), "dome" (a rounded cap of `block`: temples, '
      + 'observatories, desert houses), "cone" (a round pointed cap: round towers, turrets), "castle" (a deck behind '
      + 'crenellations: keeps, towers, gatehouses), "flat" (a slab deck with a rim). pitch "steep" doubles the rise '
      + '(Gothic, alpine), "low" flattens a dome. overhang: eaves 0 to 2 (default 1; 0 for dome and castle). Stairs '
      + 'such as stairs:stair_wood, stair_pine_wood, stair_junglewood, stair_acacia_wood, stair_brick, stair_stonebrick, '
      + 'stair_cobble, stair_desert_stonebrick (find_items "stair"). Pick the shape that suits the building, and vary it.',
    input_schema: {
      type: 'object',
      properties: { x1: pos, z1: pos, x2: pos, z2: pos, y: pos, style: { type: 'string', enum: ROOF_STYLES },
        stairs: { type: 'string' }, block: { type: 'string', description: 'Full block for dome, castle and steep courses (default: the stairs\' own block).' },
        gable: { type: 'string', description: 'Block for gable ends (default: the stairs\' own block).' },
        ridge_along: { type: 'string', enum: ['x', 'z'], description: 'Which way a gable ridge runs (default: the longer side).' },
        high: { type: 'string', enum: ['north', 'east', 'south', 'west'], description: 'For shed: the side the slope rises to.' },
        pitch: { type: 'string', enum: ['low', 'normal', 'steep'] },
        overhang: { type: 'integer', minimum: 0, maximum: 2 } },
      required: ['x1', 'z1', 'x2', 'z2', 'y'], additionalProperties: false,
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
const ROOF_MAX = 12000;
const TURN = { north: 'south', south: 'north', east: 'west', west: 'east' };
/**
 * The blocks of a roof over walls with outer corners x1, z1 and x2, z2, from height y (owner, 2026-10-27: "Roofs are
 * important, they need to learn different roof shapes. Like prism or pyramids, round, castle like"):
 *   gable    two slopes of stairs to a ridge (a prism), the ends closed up to the slope
 *   hip      four slopes to a ridge; pyramid is the same, rising to a point over a square
 *   shed     one slope, rising toward `high` (a lean-to)
 *   gambrel  a barn roof: steep lower courses, then shallow ones
 *   dome     a rounded cap of `block`
 *   cone     a round pointed cap of stairs, for round towers and turrets
 *   castle   a deck behind a parapet with crenellations (merlons every other block)
 *   flat     a slab deck with a rim of stairs
 * pitch: low or normal (a course rises one block and steps in one) or steep (rises two: a full block under each stair).
 */
export function roofNodes({ x1, z1, x2, z2, y, style = 'gable', stairs = 'stairs:stair_wood', gable, block, ridge_along: along,
  overhang = 1, pitch = 'normal', high = 'north' }) {
  const round = style === 'dome' || style === 'cone' || style === 'castle';
  const o = Math.max(0, Math.min(2, Math.round(overhang ?? (round ? 0 : 1))));
  const oo = round && style !== 'cone' ? 0 : o;
  const [ax, bx] = [Math.min(x1, x2) - oo, Math.max(x1, x2) + oo];
  const [az, bz] = [Math.min(z1, z2) - oo, Math.max(z1, z2) + oo];
  const slab = String(stairs).replace(/stairs:stair_(inner_|outer_)?/, 'stairs:slab_');
  const solid = block || String(stairs).replace(/stairs:stair_(inner_|outer_)?/, 'default:');
  const fill = gable || solid;
  const nodes = [];
  const seen = new Set();
  const put = (x, yy, z, item, facing) => {
    const k = `${x},${yy},${z}`;
    if (seen.has(k)) return;
    seen.add(k);
    nodes.push({ x, y: yy, z, item, ...(facing ? { facing } : {}) });
  };
  // Courses: course k sits at height H[k]; a steep course is a full block with a stair on it.
  const steepAt = (k, n) => pitch === 'steep' || (style === 'gambrel' && k < Math.ceil(n / 2));
  const courses = (n) => { const out = []; let h = y; for (let k = 0; k < n; k++) { const st = steepAt(k, n); out.push({ h, st }); h += st ? 2 : 1; } return out; };
  const stair = (x, h, z, facing, st) => { if (st) put(x, h, z, solid); put(x, h + (st ? 1 : 0), z, stairs, facing); };

  if (style === 'flat') {
    for (let x = ax; x <= bx; x++) for (let z = az; z <= bz; z++) {
      const rim = x === ax || x === bx || z === az || z === bz;
      put(x, y, z, rim ? stairs : slab, rim ? (z === az ? 'north' : z === bz ? 'south' : x === ax ? 'east' : 'west') : null);
    }
    return nodes;
  }
  if (style === 'castle') {
    // A deck, a parapet round it, and merlons on every other block of the parapet (corners always).
    for (let x = ax; x <= bx; x++) for (let z = az; z <= bz; z++) {
      put(x, y, z, solid);
      const rim = x === ax || x === bx || z === az || z === bz;
      if (!rim) continue;
      put(x, y + 1, z, solid);
      const corner = (x === ax || x === bx) && (z === az || z === bz);
      if (corner || (x - ax + z - az) % 2 === 0) put(x, y + 2, z, solid);
    }
    return nodes;
  }
  if (style === 'dome') {
    // Half an ellipsoid over the footprint, its shell only.
    const cx = (ax + bx) / 2;
    const cz = (az + bz) / 2;
    const rx = (bx - ax) / 2 + 0.5;
    const rz = (bz - az) / 2 + 0.5;
    const ry = Math.max(2, Math.min(rx, rz) * (pitch === 'low' ? 0.6 : pitch === 'steep' ? 1.4 : 1));
    const inside = (x, h, z) => ((x - cx) / rx) ** 2 + ((z - cz) / rz) ** 2 + (h / ry) ** 2 <= 1;
    for (let x = ax; x <= bx; x++) for (let z = az; z <= bz; z++) for (let h = 0; h <= Math.ceil(ry); h++) {
      if (!inside(x, h, z)) continue;
      if (!inside(x + 1, h, z) || !inside(x - 1, h, z) || !inside(x, h, z + 1) || !inside(x, h, z - 1) || !inside(x, h + 1, z)) put(x, y + h, z, solid);
    }
    return nodes;
  }
  if (style === 'cone') {
    // Rings of stairs facing in, each a block narrower, to a point (a slab, or a full block when steep).
    const cx = (ax + bx) / 2;
    const cz = (az + bz) / 2;
    const r0 = Math.min(bx - ax, bz - az) / 2 + 0.5;
    const n = Math.ceil(r0);
    const cs = courses(n);
    for (let k = 0; k < n; k++) {
      const r = r0 - k;
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) {
        const d = Math.hypot(x - cx, z - cz);
        if (d > r || d <= r - 1) continue;
        const dx = x - cx;
        const dz = z - cz;
        const facing = Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 'west' : 'east') : (dz > 0 ? 'south' : 'north');
        if (r <= 1) { put(x, cs[k].h, z, cs[k].st ? solid : slab); if (cs[k].st) put(x, cs[k].h + 1, z, solid); }
        else stair(x, cs[k].h, z, facing, cs[k].st);
      }
    }
    const tip = cs[n - 1];
    put(Math.round(cx), tip.h + (tip.st ? 2 : 1), Math.round(cz), pitch === 'steep' ? 'default:fence_wood' : slab);
    return nodes;
  }
  if (style === 'shed') {
    // One slope across the footprint, rising toward `high`.
    const facing = TURN[TURN[high]] ? high : 'north';
    const alongZ = facing === 'north' || facing === 'south';
    const [lo, hiEnd] = alongZ ? [az, bz] : [ax, bx];
    const n = hiEnd - lo + 1;
    const cs = courses(n);
    for (let k = 0; k < n; k++) {
      const c = facing === 'north' || facing === 'east' ? lo + k : hiEnd - k;
      for (let s = alongZ ? ax : az; s <= (alongZ ? bx : bz); s++) {
        const [x, z] = alongZ ? [s, c] : [c, s];
        stair(x, cs[k].h, z, facing, cs[k].st);
        // Close the two open sides under the slope.
        if (s === (alongZ ? Math.min(x1, x2) : Math.min(z1, z2)) || s === (alongZ ? Math.max(x1, x2) : Math.max(z1, z2))) {
          for (let h = y; h < cs[k].h; h++) put(x, h, z, fill);
        }
      }
    }
    return nodes;
  }
  if (style === 'hip' || style === 'pyramid') {
    const n = Math.ceil((Math.min(bx - ax, bz - az) + 1) / 2);
    const cs = courses(n + 1);
    for (let k = 0; ; k++) {
      const [lx, rx, lz, rz] = [ax + k, bx - k, az + k, bz - k];
      if (lx > rx || lz > rz) break;
      const { h, st } = cs[k];
      if (lx === rx || lz === rz) {
        for (let x = lx; x <= rx; x++) for (let z = lz; z <= rz; z++) { if (st) put(x, h, z, solid); put(x, h + (st ? 1 : 0), z, slab); }
        break;
      }
      for (let x = lx; x <= rx; x++) { stair(x, h, lz, 'north', st); stair(x, h, rz, 'south', st); }
      for (let z = lz + 1; z < rz; z++) { stair(lx, h, z, 'east', st); stair(rx, h, z, 'west', st); }
    }
    return nodes;
  }
  // Gable and gambrel: the slopes rise across the short way; the walls under the two ends are closed to the roof.
  const alongX = along ? along === 'x' : bx - ax >= bz - az;
  const [wl, wr] = alongX ? [Math.min(x1, x2), Math.max(x1, x2)] : [Math.min(z1, z2), Math.max(z1, z2)];
  const [lo, hi] = alongX ? [az, bz] : [ax, bx];
  const [s0, s1] = alongX ? [ax, bx] : [az, bz];
  const n = Math.ceil((hi - lo + 1) / 2);
  const cs = courses(n);
  for (let k = 0; k < n; k++) {
    const [l, r] = [lo + k, hi - k];
    const { h, st } = cs[k];
    for (let s = s0; s <= s1; s++) {
      const at = (c, hh, item, facing) => (alongX ? put(s, hh, c, item, facing) : put(c, hh, s, item, facing));
      if (l === r) { if (st) at(l, h, solid); at(l, h + (st ? 1 : 0), slab); continue; }
      if (st) { at(l, h, solid); at(r, h, solid); }
      at(l, h + (st ? 1 : 0), stairs, alongX ? 'north' : 'east');
      at(r, h + (st ? 1 : 0), stairs, alongX ? 'south' : 'west');
      if (s === wl || s === wr) for (let c = l + 1; c < r; c++) for (let hh = h; hh <= h + (st ? 1 : 0); hh++) at(c, hh, fill);
    }
  }
  return nodes;
}

/**
 * A door is an item (doors:door_wood) that hangs as two blocks: the door (doors:door_wood_a, facing the way given)
 * and a hidden block above it. The game takes only blocks, so a door item becomes those two (owner, 2026-10-27: "Bot
 * says no door").
 */
export function withDoors(blocks) {
  return blocks.flatMap((b) => {
    if (!/^doors:(door|gate)_[a-z0-9_]+$/.test(b.item ?? '') || /_[abcd]$|_(open|closed)$/.test(b.item)) return [b];
    if (b.item.startsWith('doors:gate_')) return [{ ...b, item: `${b.item}_closed` }];
    return [{ ...b, item: `${b.item}_a` }, { x: b.x, y: b.y + 1, z: b.z, item: 'doors:hidden', ...(b.facing ? { facing: b.facing } : {}) }];
  });
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
