// The isometric map: a picture of an area of the world, cube by cube, as if seen from the south-east and above
// (owner, 2026-10-27: "can you just make on isometric?", "get maptesters assets and do it that way"). The mod reads
// the blocks (its `scan` action: each column's top and the blocks down its visible sides); this file colours them
// with minetestmapper's table (server/map/colors.txt, BSD-2-Clause), draws each block as three shaded faces, back to
// front, marks where the characters and players stand, and writes a PNG. Pure Node: zlib for the PNG, no packages.

import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const COLORS_FILE = new URL('./map/colors.txt', import.meta.url);
const BG = [27, 34, 23];
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
/** A node's colour: from the table, else a guess from its name, else a steady grey of its own. */
export function colorOf(name) {
  colors ??= loadColors();
  const c = colors.get(name);
  if (c) return c;
  if (/water/.test(name)) return [39, 66, 106, 160];
  if (/lava/.test(name)) return [220, 90, 20, 255];
  if (/leaves|grass|bush|fern|moss/.test(name)) return [52, 104, 38, 255];
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

/**
 * Draw a scan (the mod's `scan` result) as an isometric picture. marks: { color: "#rrggbb" } per mark, by id or
 * player. Returns { png, width, height }.
 */
export function renderIso(scan, { markColors = {}, scale } = {}) {
  const { x1, z1, w, d, y1 } = scan;
  const names = Array.isArray(scan.names) ? scan.names : [];
  const cols = Array.isArray(scan.cols) ? scan.cols : [];
  let hmin = Infinity;
  let hmax = -Infinity;
  for (const c of cols) {
    if (!c) continue;
    hmax = Math.max(hmax, c[0]);
    hmin = Math.min(hmin, c[0] - (c.length - 2));
  }
  if (hmax === -Infinity) { hmin = y1; hmax = y1 + 1; }
  const a = scale ?? (Math.max(w, d) <= 48 ? 8 : Math.max(w, d) <= 80 ? 6 : 4);
  const sp = sprite(a);
  const tall = hmax - hmin + 3;
  const width = (w + d) * a + 2 * a;
  const height = Math.round(((w + d) * a) / 2 + tall * a + 3 * a);
  const px = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) px.set(BG, i * 3);
  // A block at world (x, y, z) has its sprite's top-left here, placed by where it sits in the area (so the same area
  // anywhere in the world draws the same): x runs down-right, z down-left, y up.
  const ox = d * a;
  const oy = (hmax - y1 + 2) * a;
  const at = (x, y, z) => {
    const rx = x - x1;
    const rz = z - z1;
    return [ox + (rx - rz) * a, oy + ((rx + rz) * a) / 2 - (y - y1) * a];
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
        const o = (ty * width + tx) * 3;
        for (let c = 0; c < 3; c++) px[o + c] = Math.round(px[o + c] * (1 - alpha) + Math.min(255, rgba[c] * k) * alpha);
      }
    }
  };
  // Back to front: rows of equal x + z from the far corner, each column bottom up.
  for (let s = 0; s <= w + d - 2; s++) {
    for (let x = Math.max(0, s - d + 1); x <= Math.min(w - 1, s); x++) {
      const z = s - x;
      const col = cols[z * w + x];
      if (!col) continue;
      const top = col[0];
      for (let k = col.length - 1; k >= 1; k--) {
        const idx = col[k];
        if (idx < 0) continue;
        const name = names[idx];
        if (!name) continue;
        const y = top - (k - 1);
        const [sx, sy] = at(x1 + x, y, z1 + z);
        blit(sx, sy, colorOf(name));
      }
    }
  }
  // Marks: a pin of the character's colour (players white) over where they stand.
  for (const m of Array.isArray(scan.marks) ? scan.marks : []) {
    const hex = markColors[m.id ?? m.player] ?? (m.player ? '#ffffff' : '#f2b84b');
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 255);
    const [sx, sy] = at(m.x, m.y + 2, m.z);
    const cx = Math.round(sx + a);
    const cy = Math.round(sy + a / 2);
    const r = Math.max(3, Math.round(a * 0.7));
    for (let yy = -r - 1; yy <= 2 * r + 1; yy++) {
      for (let xx = -r - 1; xx <= r + 1; xx++) {
        const inPin = yy <= 0 ? xx * xx + yy * yy <= r * r : Math.abs(xx) <= r - (yy * r) / (2 * r);
        const ring = yy <= 0 ? xx * xx + yy * yy <= (r + 1) * (r + 1) : Math.abs(xx) <= r + 1 - (yy * r) / (2 * r);
        const tx = cx + xx;
        const ty = cy + yy;
        if (tx < 0 || ty < 0 || tx >= width || ty >= height || !(inPin || ring)) continue;
        px.set(inPin ? rgb : [16, 18, 14], (ty * width + tx) * 3);
      }
    }
  }
  return { png: encodePng(px, width, height), width, height };
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

/** An RGB picture as a PNG. */
export function encodePng(rgb, width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
