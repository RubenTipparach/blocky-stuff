// What the mod's scan returns, worked out in JavaScript from a world given as a function (x, y, z) -> node name or
// null for air: the same rule as mods/ai_bot/init.lua (a block goes in when a face of it can be seen: open air or
// foliage above it or to its south or east, the cut at the top, or the edge of the area).
export function fakeScan(world, { x1, z1, w, d, y1, y2 }) {
  const names = [];
  const index = new Map();
  const id = (n) => { if (!index.has(n)) { index.set(n, names.length); names.push(n); } return index.get(n); };
  const open = (n) => !n || /leaves/.test(n);
  const cols = [];
  for (let z = z1; z < z1 + d; z++) {
    for (let x = x1; x < x1 + w; x++) {
      const col = [];
      const edge = x === x1 + w - 1 || z === z1 + d - 1;
      for (let y = y2; y >= y1; y--) {
        const n = world(x, y, z);
        if (!n) continue;
        if (y === y2 || edge || open(world(x, y + 1, z)) || open(world(x, y, z + 1)) || open(world(x + 1, y, z))) col.push(y, id(n));
      }
      cols.push(col.length ? col : false);
    }
  }
  return { x1, z1, w, d, y1, names, cols, marks: [] };
}

// A small world: rolling grass over dirt and stone, a pond, a stone house with a wooden roof, a tree, and a cave.
export function sampleWorld(x, y, z) {
  const ground = Math.round(6 + 3 * Math.sin(x / 6) + 2 * Math.cos(z / 5));
  if (x >= 10 && x <= 17 && z >= 10 && z <= 16) {
    const floor = 9;
    const wall = x === 10 || x === 17 || z === 10 || z === 16;
    if (y < floor) return 'default:stone';
    if (y === floor + 5) return 'default:wood';
    if (wall && y > floor && y < floor + 5) return x === 10 && z === 13 && y === floor + 2 ? 'default:glass' : 'default:cobble';
    return null;
  }
  const tree = (x - 26) ** 2 + (z - 26) ** 2;
  if (x === 26 && z === 26 && y > ground && y <= ground + 5) return 'default:tree';
  if (tree <= 5 && y >= ground + 4 && y <= ground + 6) return 'default:leaves';
  if (x > 28 && z < 12 && y <= 4) return y >= 3 ? 'default:water_source' : 'default:sand';
  if ((x - 20) ** 2 + (y - 1) ** 2 + (z - 30) ** 2 < 10) return null; // a cave
  if (y > ground) return null;
  if (y === ground) return 'default:dirt_with_grass';
  if (y > ground - 3) return 'default:dirt';
  if (y > ground - 6 && (x * 7 + y * 3 + z) % 23 === 0) return 'default:stone_with_iron';
  return 'default:stone';
}

// The mod's `runs` scan of the same world: each column top down as runs of one block (top y, length, name index).
export function fakeRuns(world, { x1, z1, w, d, y1, y2 }) {
  const names = [];
  const index = new Map();
  const id = (n) => { if (!index.has(n)) { index.set(n, names.length); names.push(n); } return index.get(n); };
  const cols = [];
  for (let z = z1; z < z1 + d; z++) {
    for (let x = x1; x < x1 + w; x++) {
      const col = [];
      let top = null, len = 0, cur = null;
      for (let y = y2; y >= y1; y--) {
        const n = world(x, y, z);
        const c = n ? id(n) : null;
        if (c !== null && c === cur && top - len === y) { len++; continue; }
        if (cur !== null) col.push(top, len, cur);
        top = y; len = c === null ? 0 : 1; cur = c;
      }
      if (cur !== null) col.push(top, len, cur);
      cols.push(col);
    }
  }
  return { x1, z1, w, d, y1, names, cols, marks: [] };
}
