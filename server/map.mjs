// The isometric map: a picture of an area of the world, cube by cube, as if seen from the south-east and above
// (owner, 2026-10-27: "can you just make on isometric?", "get maptesters assets and do it that way"). The mod reads
// the blocks (its `scan` action: each column's top and the blocks down its visible sides); this file colours them
// with minetestmapper's table (server/map/colors.txt, BSD-2-Clause), draws each block as three shaded faces, back to
// front, marks where the characters and players stand, and writes a PNG. Pure Node: zlib for the PNG, no packages.

import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const COLORS_FILE = new URL('./map/colors.txt', import.meta.url);
// A dark blue behind the picture (owner, 2026-10-27: "background of map should be dark blue").
const BG = [20, 32, 56];
// How much light each face gets: the top, the face toward the viewer's left (south) and right (east).
const SHADE = { top: 1, left: 0.8, right: 0.64 };

/** minetestmapper's colours: name -> [r, g, b, a]. */
export function loadColors(text = readFileSync(COLORS_FILE, 'utf8')) {
  const out = new Map();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [name, r, g, b, a] = t.split(/\s+/);
    if (name && r !== undefined) out.set(name, [Number(r), Number(g), Number(b), a === undefined ? 255 : Number(a)]);
  }
  return out;
}

let colors = null;
// minetestmapper's colours are a texture's average, often dark: lift them a little so a canopy reads as one.
const lift = ([r, g, b, a]) => [Math.min(255, r * 0.9 + 26), Math.min(255, g * 0.9 + 26), Math.min(255, b * 0.9 + 22), a];
/** A node's colour: from the table, else a guess from its name, else a steady grey of its own. */
export function colorOf(name) {
  colors ??= loadColors();
  const c = colors.get(name);
  // Foliage is drawn see-through, so what is under a canopy shows (owner: "so were not just seeing the tops").
  if (c) return /leaves|needles|foliage/.test(name) ? [...lift(c).slice(0, 3), 80] : lift(c);
  if (/water/.test(name)) return [39, 66, 106, 160];
  if (/lava/.test(name)) return [220, 90, 20, 255];
  if (/leaves|needles|foliage/.test(name)) return [70, 120, 50, 80];
  if (/grass|bush|fern|moss/.test(name)) return [52, 104, 38, 255];
  if (/glass/.test(name)) return [190, 220, 230, 110];
  if (/wood|tree|plank|fence/.test(name)) return [150, 112, 70, 255];
  if (/torch|lamp|light/.test(name)) return [250, 210, 120, 255];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const v = 110 + (h % 70);
  return [v, v - 6, v - 12, 255];
}

// One block's sprite: for each pixel of a cube 2a wide and 2a tall, which face it belongs to (0 none, 1 top, 2 left,
// 3 right) and whether it is on that face's edge (drawn a little darker, so blocks read as blocks).
function sprite(a) {
  const w = 2 * a;
  const face = new Uint8Array(w * w);
  const edge = new Uint8Array(w * w);
  const inside = (px, py, poly) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  const polys = [
    [[a, 0], [w, a / 2], [a, a], [0, a / 2]], // top
    [[0, a / 2], [a, a], [a, w], [0, w - a / 2]], // left (south face)
    [[a, a], [w, a / 2], [w, w - a / 2], [a, w]], // right (east face)
  ];
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const k = polys.findIndex((p) => inside(x + 0.5, y + 0.5, p));
      face[y * w + x] = k + 1;
    }
  }
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const f = face[y * w + x];
      if (!f) continue;
      const n = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]
        .some(([nx, ny]) => nx < 0 || ny < 0 || nx >= w || ny >= w || face[ny * w + nx] !== f);
      edge[y * w + x] = n ? 1 : 0;
    }
  }
  return { w, face, edge };
}

// A 5 by 7 pixel font for names on the pictures: capitals, digits and a few marks (others print as a space).
const GLYPHS = {
  A: '01110100011000111111100011000110001', B: '11110100011000111110100011000111110', C: '01110100011000010000100001000101110',
  D: '11110100011000110001100011000111110', E: '11111100001000011110100001000011111', F: '11111100001000011110100001000010000',
  G: '01110100011000010111100011000101111', H: '10001100011000111111100011000110001', I: '01110001000010000100001000010001110',
  J: '00111000100001000010000101001001100', K: '10001100101010011000101001001010001', L: '10000100001000010000100001000011111',
  M: '10001110111010110101100011000110001', N: '10001100011100110101100111000110001', O: '01110100011000110001100011000101110',
  P: '11110100011000111110100001000010000', Q: '01110100011000110001101011001001101', R: '11110100011000111110101001001010001',
  S: '01111100001000001110000010000111110', T: '11111001000010000100001000010000100', U: '10001100011000110001100011000101110',
  V: '10001100011000110001100010101000100', W: '10001100011000110101101011010101010', X: '10001100010101000100010101000110001',
  Y: '10001100010101000100001000010000100', Z: '11111000010001000100010001000011111', 0: '01110100011001110101110011000101110',
  1: '00100011000010000100001000010001110', 2: '01110100010000100010001000100011111', 3: '11110000010000101110000010000111110',
  4: '00010001100101010010111110001000010', 5: '11111100001111000001000011000101110', 6: '00110010001000011110100011000101110',
  7: '11111000010001000100010000100001000', 8: '01110100011000101110100011000101110', 9: '01110100011000101111000010001001100',
  '-': '00000000000000011111000000000000000', '.': '00000000000000000000000000110001100', '_': '00000000000000000000000000000011111',
};

/** Write `text` (in capitals) at (x, y) through put(x, y, rgb), each font pixel `s` by `s`, on a dark plate. */
export function drawLabel(put, x, y, text, rgb, s = 2) {
  const t = String(text).toUpperCase().slice(0, 24);
  const w = t.length * 6 * s + 3 * s;
  const h = 7 * s + 4 * s;
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) put(x + xx, y + yy, [20, 24, 18]);
  [...t].forEach((ch, i) => {
    const g = GLYPHS[ch];
    if (!g) return;
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (g[row * 5 + col] !== '1') continue;
        for (let dy = 0; dy < s; dy++) {
          for (let dx = 0; dx < s; dx++) put(x + 2 * s + i * 6 * s + col * s + dx, y + 2 * s + row * s + dy, rgb);
        }
      }
    }
  });
}

/**
 * Draw a scan (the mod's `scan` result: per column, the visible blocks as pairs y, name index, top down) as an
 * isometric picture. marks: a pin and name per character (markColors, markNames by id) or player. `fixed` draws in a
 * frame of fixed height (ymin to ymax), so pictures of neighbouring areas line up into one map; `transparent` leaves
 * the background clear for that. Returns { png, width, height }.
 */
export function renderIso(scan, { markColors = {}, markNames = {}, scale, fixed = null, transparent = false, focus = null } = {}) {
  const { x1, z1, w, d, y1 } = scan;
  const names = Array.isArray(scan.names) ? scan.names : [];
  const cols = Array.isArray(scan.cols) ? scan.cols : [];
  let hmin = Infinity;
  let hmax = -Infinity;
  for (const c of cols) {
    if (!c || c.length < 2) continue;
    hmax = Math.max(hmax, c[0]);
    hmin = Math.min(hmin, c[c.length - 2]);
  }
  if (fixed) { hmin = fixed.ymin; hmax = fixed.ymax; }
  if (hmax === -Infinity) { hmin = y1; hmax = y1 + 1; }
  const a = scale ?? (Math.max(w, d) <= 48 ? 8 : Math.max(w, d) <= 80 ? 6 : 4);
  const sp = sprite(a);
  const tall = hmax - hmin + 3;
  const width = (w + d) * a + 2 * a;
  const height = Math.round(((w + d) * a) / 2 + tall * a + 3 * a);
  const px = new Uint8Array(width * height * 4);
  if (!transparent) for (let i = 0; i < width * height; i++) px.set([...BG, 255], i * 4);
  // A block at world (x, y, z) has its sprite's top-left here, placed by where it sits in the area (so the same area
  // anywhere in the world draws the same): x runs down-right, z down-left, y up. In a fixed frame the origin depends
  // only on the frame, which is what lines neighbouring pictures up.
  const ox = d * a;
  const oy = (hmax - (fixed ? hmin : y1) + 2) * a;
  const base = fixed ? hmin : y1;
  const at = (x, y, z) => {
    const rx = x - x1;
    const rz = z - z1;
    return [ox + (rx - rz) * a, oy + ((rx + rz) * a) / 2 - (y - base) * a];
  };
  const blit = (sx, sy, rgba) => {
    const alpha = (rgba[3] ?? 255) / 255;
    for (let yy = 0; yy < sp.w; yy++) {
      const ty = Math.round(sy) + yy;
      if (ty < 0 || ty >= height) continue;
      for (let xx = 0; xx < sp.w; xx++) {
        const f = sp.face[yy * sp.w + xx];
        if (!f) continue;
        const tx = Math.round(sx) + xx;
        if (tx < 0 || tx >= width) continue;
        const k = (f === 1 ? SHADE.top : f === 2 ? SHADE.left : SHADE.right) * (sp.edge[yy * sp.w + xx] ? 0.86 : 1);
        const o = (ty * width + tx) * 4;
        const da = px[o + 3] / 255;
        const oa = alpha + da * (1 - alpha);
        for (let c = 0; c < 3; c++) {
          const src = Math.min(255, rgba[c] * k);
          px[o + c] = oa ? Math.round((src * alpha + px[o + c] * da * (1 - alpha)) / oa) : 0;
        }
        px[o + 3] = Math.round(oa * 255);
      }
    }
  };
  // Back to front: rows of equal x + z from the far corner, each column bottom up.
  for (let s = 0; s <= w + d - 2; s++) {
    for (let x = Math.max(0, s - d + 1); x <= Math.min(w - 1, s); x++) {
      const z = s - x;
      const col = cols[z * w + x];
      if (!col || col.length < 2) continue;
      for (let k = col.length - 2; k >= 0; k -= 2) {
        const name = names[col[k + 1]];
        if (!name) continue;
        const [sx, sy] = at(x1 + x, col[k], z1 + z);
        blit(sx, sy, colorOf(name));
      }
    }
  }
  // The drawing above has east going down-right and north down-left, which is the world in a mirror (owner,
  // 2026-10-27: "the bridge sways to the right, the map sways to the left"): flip it left to right, so the picture
  // matches the game. Marks and names go on after, at their flipped places, so the text reads the right way.
  for (let y = 0; y < height; y++) {
    for (let x = 0, r = width - 1; x < r; x++, r--) {
      const o1 = (y * width + x) * 4;
      const o2 = (y * width + r) * 4;
      for (let c = 0; c < 4; c++) { const tmp = px[o1 + c]; px[o1 + c] = px[o2 + c]; px[o2 + c] = tmp; }
    }
  }
  // Marks: a pin of the character's colour (players white) over where they stand, and the name beside it.
  const put = (tx, ty, rgb) => { if (tx >= 0 && ty >= 0 && tx < width && ty < height) px.set([...rgb, 255], (ty * width + tx) * 4); };
  // The one the picture is of (focus) goes last, on top of the rest (owner, 2026-10-27: "howcome the blocky image
  // doesnt show blockys nametag": Moss, a few blocks away, was drawn over her); names never cover one another.
  const marks = (Array.isArray(scan.marks) ? scan.marks : []).slice()
    .sort((p, q) => (p.id === focus ? 1 : 0) - (q.id === focus ? 1 : 0));
  const taken = [];
  const labelAt = (x, y, text) => {
    const w = String(text).slice(0, 24).length * 12 + 6;
    const h = 22;
    let yy = y;
    for (let tries = 0; tries < 8 && taken.some((b) => x < b.x + b.w && b.x < x + w && yy < b.y + b.h && b.y < yy + h); tries++) yy += h + 2;
    taken.push({ x, y: yy, w, h });
    return yy;
  };
  for (const m of marks) {
    const hex = markColors[m.id ?? m.player] ?? (m.player ? '#ffffff' : '#f2b84b');
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 255);
    const [sx, sy] = at(m.x, m.y + 2, m.z);
    const cx = width - 1 - Math.round(sx + a);
    const cy = Math.round(sy + a / 2);
    const r = Math.max(3, Math.round(a * 0.7));
    for (let yy = -r - 1; yy <= 2 * r + 1; yy++) {
      for (let xx = -r - 1; xx <= r + 1; xx++) {
        const inPin = yy <= 0 ? xx * xx + yy * yy <= r * r : Math.abs(xx) <= r - (yy * r) / (2 * r);
        const ring = yy <= 0 ? xx * xx + yy * yy <= (r + 1) * (r + 1) : Math.abs(xx) <= r + 1 - (yy * r) / (2 * r);
        if (inPin || ring) put(cx + xx, cy + yy, inPin ? rgb : [16, 18, 14]);
      }
    }
    const name = m.player ?? markNames[m.id] ?? m.id;
    if (name) drawLabel(put, cx + r + 4, labelAt(cx + r + 4, cy - r - 2, name), name, m.player ? [255, 255, 255] : rgb.map((v) => Math.min(255, v + 60)));
  }
  return { png: encodePng(px, width, height, 4), width, height };
}

/**
 * A top-down tile for the web map: `scan` of size×size columns (tops only), each `px` pixels square, shaded by the
 * slope to its north-west neighbour so hills read. Ungenerated ground stays clear. Returns a PNG (RGBA).
 */
export function renderTile(scan, { px = 4 } = {}) {
  const { w, d } = scan;
  const names = Array.isArray(scan.names) ? scan.names : [];
  const cols = Array.isArray(scan.cols) ? scan.cols : [];
  const W = w * px;
  const H = d * px;
  const out = new Uint8Array(W * H * 4);
  const top = (x, z) => (x < 0 || z < 0 || x >= w || z >= d || !cols[z * w + x] ? null : cols[z * w + x][0]);
  for (let z = 0; z < d; z++) {
    for (let x = 0; x < w; x++) {
      const col = cols[z * w + x];
      if (!col) continue;
      let [r, g, b, a] = colorOf(names[col[1]] ?? '');
      // Under a canopy: the ground, tinted with the leaves over it.
      if (col[2] !== undefined && col[2] !== null) {
        const [lr, lg, lb] = colorOf(names[col[2]] ?? '');
        [r, g, b] = [r * 0.55 + lr * 0.45, g * 0.55 + lg * 0.45, b * 0.55 + lb * 0.45];
        a = 255;
      }
      // North (smaller z) and west: a rise toward them is in shade, a fall is lit.
      const ref = top(x - 1, z) ?? top(x, z - 1) ?? col[0];
      const k = Math.max(0.7, Math.min(1.25, 1 + (col[0] - ref) * 0.08));
      // Rows run north to south down the tile: the scan's z grows south, so row = z.
      for (let yy = 0; yy < px; yy++) {
        for (let xx = 0; xx < px; xx++) {
          const o = ((z * px + yy) * W + (x * px + xx)) * 4;
          out[o] = Math.min(255, r * k);
          out[o + 1] = Math.min(255, g * k);
          out[o + 2] = Math.min(255, b * k);
          out[o + 3] = Math.max(140, a ?? 255);
        }
      }
    }
  }
  return encodePng(out, W, H, 4);
}

// ---- PNG ----

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};

/** An RGB (channels 3) or RGBA (4) picture as a PNG. */
export function encodePng(rgb, width, height, channels = 3) {
  const row = width * channels;
  const raw = Buffer.alloc((row + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (row + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * row, row).copy(raw, y * (row + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, channels === 4 ? 6 : 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
