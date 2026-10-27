// Pictures of what the characters are up to (owner, 2026-10-27: "I just want screenshots or something of what these
// bots are up occasionally", "install map server, open to public view", "a server API to render stuff so the discord
// bot can post"). Isometric snapshots (server/map.mjs) of each character's project site, or of where she stands, kept
// on the volume and shown on a public page; renders on request; and posts to Discord every half hour while someone
// is in the game (owner, 2026-10-27: "post this only every once every 30 mins on the server IF theres anyone
// online"), and on /picture in Discord.
//
//   GET /map                         the public page: a zoomable isometric map of the world (owner, 2026-10-27: "a google
//                                    style map", "I wanted the isometric look on that map") with a depth slider, the
//                                    characters and players on it, and the latest picture of each character;
//                                    /map?view=flat is the same world flat, from above
//   GET /map/chunk/<cx>/<cz>.json    the 64 by 64 block chunk (cx, cz) as data: each column as runs of one block, and
//                                    each block's colour; the page draws the isometric map from these itself, so a cut
//                                    or a toggle is redrawn in the browser at once (owner: "ship renderer on front end")
//   GET /map/iso/<cx>/<cz>.png?top=  the same chunk drawn isometric on the server, cut at y = top (for other uses)
//   GET /map/tiles/<x>/<y>.png       a 64 by 64 block tile of the flat map (x east, y south)
//   GET /map/where.json              where the characters and players are now
//   GET /map/explored.json           the 64-block chunks the world has anything in, and their bounds (owner: "isomap
//                                    should be bounded by explored areas ... so I cant just scroll infinitely")
//   GET /map/img/<name>.png          a kept picture
//   GET /map/render?x=&z=[&y=][&r=]  a fresh picture of any spot (r up to 64 blocks around), a few a minute per address
//
// The world as the map knows it is kept on the volume, a 64-block chunk at a time (every column as runs of one block),
// and everything above is drawn from that store, never by scanning the game on request (owner, 2026-10-27: "the mapping
// program should update its db every 5 mins if there is server activity, so mapping calls dont call a scan
// individually"). Every 5 minutes, when anything happened (a build, a field, a player in the game), the chunks it
// touched are read from the game again; a chunk nobody has mapped yet is read once, the first time it is wanted.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { renderIso, renderTile, colorOf } from './map.mjs';

const RADIUS = 64; // a snapshot covers 128 by 128 blocks (owner, 2026-10-27: "I'd double the block resolution 128x128")
const EVERY_MS = 20 * 60_000; // a character's picture is refreshed this often while she is about
const RENDER_GAP_MS = 15_000; // one on-request render per address this often
const MAP_COMMAND_GAP_MS = 30_000; // /picture at most this often
const TILE = 64; // blocks a side, per tile
const TILE_KEEP_MS = 5 * 60_000; // a drawn tile is good for this long (drawn from the store: cheap)
const SURVEY_MS = 5 * 60_000; // the store is brought up to date this often, when anything happened
const SURVEY_MAX = 40; // chunks read again in one survey at most (the rest wait for the next)
const TILE_AT_ONCE = 4; // chunks read from the game at once, so the game never stalls on a map
// See-through on the map, as the mod's scan has it (leaves, and blocks one walks through): the ground under them shows.
const SEE_THROUGH = /leaves|needles|foliage|flowers:|sapling|grass_\d|junglegrass|dry_shrub|fern|torch|mushroom|water|lava|farming:(seed|wheat|cotton)|snow$/;
// Bump when tiles are drawn differently: kept tiles of an older drawing are drawn again.
const TILE_VERSION = 3;
// The isometric map's frame, shared with the page's script (which places each chunk from these numbers alone).
export const ISO = { A: 4, YMIN: -32, YMAX: 127, C: 64 };
// Every post ends with this (owner: "have the discord bot tell players to check out this site for more maps").
const MORE = (url) => `More maps: ${url}/map`;

export function createMaps({ db, game, config, characters, chat, now = () => Date.now(), log = console }) {
  const dir = join(config.dataDir, 'maps');
  if (db.json('maps.tiles.version', 0) !== TILE_VERSION) {
    db.putJson('maps.tiles', {});
    db.putJson('maps.tiles.version', TILE_VERSION);
  }
  const lastAsk = new Map(); // address -> when it last rendered on request
  const lastRefresh = new Map(); // address -> when it last asked for a refresh
  const REFRESH_GAP_MS = 60_000;
  let lastMapCommand = 0;
  let busy = false;

  const kept = () => db.json('maps', {});
  const keep = (key, meta) => db.putJson('maps', { ...kept(), [key]: meta });
  const colorsByMark = () => Object.fromEntries(characters().map((c) => [c.id, c.dressColor || c.chatColor]));
  const namesByMark = () => Object.fromEntries(characters().map((c) => [c.id, c.name]));
  // every: minutes between automatic Discord posts (0: none), and only while a player is online.
  const settings = () => {
    const s = db.json('maps.settings', {});
    return { every: Number.isFinite(s.minutes) ? s.minutes : 30 };
  };

  /** A picture of the area around (x, z): { png, scan } or { error }. y: about the ground there, if known. */
  async function render({ x, z, y = null, r = RADIUS }) {
    const rr = Math.max(8, Math.min(64, Math.round(r)));
    const yy = Number.isFinite(y) ? Math.round(y) : null;
    // Down to 48 blocks under her, whole columns to there (owner: "this should scan down to the lower depths").
    const scan = await area(Math.round(x) - rr, Math.round(z) - rr, 2 * rr, 2 * rr,
      yy === null ? ISO.YMIN : yy - 48, yy === null ? 120 : yy + 50);
    if (!scan) return { error: 'There is no map of that spot yet: the game has not been there, or is not answering.' };
    return { png: renderIso(scan, { markColors: colorsByMark(), markNames: namesByMark() }).png, scan };
  }

  /**
   * Where to aim: at the character herself (owner: "you should aim where the bot is"), said with what she is up to;
   * her project's site only when her body is not about.
   */
  function spotOf(ch) {
    const what = ch.project ? `building ${ch.project.title} (${ch.project.done} of ${ch.project.steps.length} steps)`
      : ch.lastProject && now() - ch.lastProject.at < 86_400_000 ? `just finished ${ch.lastProject.title}` : 'out and about';
    const body = game.bodies?.find((b) => b.id === ch.id);
    if (body) return { x: body.x, y: body.y, z: body.z, what };
    if (ch.project?.site) return { ...ch.project.site, what };
    if (ch.lastProject?.site && now() - ch.lastProject.at < 86_400_000) return { ...ch.lastProject.site, what };
    return null;
  }

  /** Take (and keep) a character's picture. Returns the kept record, or null. */
  async function snapshot(ch) {
    const spot = spotOf(ch);
    if (!spot || !game.connected) return null;
    const out = await render(spot);
    if (out.error) { log.error(`map of ${ch.name}: ${out.error}`); return null; }
    await mkdir(dir, { recursive: true });
    const file = `${ch.id.replace(/[^a-z0-9-]/g, '')}.png`;
    await writeFile(join(dir, file), out.png);
    const meta = { key: ch.id, file, title: `${ch.name}: ${spot.what}`, x: spot.x, y: spot.y, z: spot.z, at: now(),
      project: ch.project?.title ?? ch.lastProject?.title ?? null };
    keep(ch.id, meta);
    return { ...meta, png: out.png };
  }

  /**
   * Every minute: refresh each character's picture when due (for the page), and every `every` minutes, while a player
   * is online, post each one's picture to Discord, saying so when she finished a project since the last post.
   */
  async function tick() {
    await survey().catch((err) => log.error('map survey failed:', err));
    if (busy || !game.connected) return;
    busy = true;
    try {
      const posted = db.json('maps.posted', {});
      const { every } = settings();
      const postNow = every > 0 && chat.mode && game.players.length > 0 && now() - (posted.at ?? 0) >= every * 60_000;
      for (const ch of characters()) {
        const was = kept()[ch.id];
        if (!postNow && was && now() - was.at < EVERY_MS) continue;
        const snap = await snapshot(ch);
        if (!snap || !postNow) continue;
        const finished = ch.lastProject && ch.lastProject.at > (posted[`${ch.id}:finished`] ?? 0);
        if (finished) posted[`${ch.id}:finished`] = ch.lastProject.at;
        await postPicture(snap, finished
          ? `${ch.name} finished ${ch.lastProject.title} at ${ch.lastProject.site.x}, ${ch.lastProject.site.y}, ${ch.lastProject.site.z}!`
          : `${ch.name} is ${snap.title.split(': ')[1]}.`, ch);
      }
      if (postNow) posted.at = now();
      db.putJson('maps.posted', posted);
    } catch (err) {
      log.error('map tick failed:', err);
    } finally {
      busy = false;
    }
  }

  const postPicture = (snap, text, ch) => chat.postImage?.({ png: snap.png, filename: snap.file, text: `${text}\n${MORE(config.publicUrl)}`,
    as: ch?.name, color: ch?.chatColor, link: `${config.publicUrl}/map` });

  /** Post the characters' pictures now (an admin's button): all of them, or the one with `id`. Returns how many. */
  async function postNow(id = null) {
    if (!chat.mode) throw new Error('Discord is not set up.');
    let n = 0;
    for (const ch of characters().filter((c) => !id || c.id === id)) {
      const snap = await snapshot(ch);
      if (snap && (await postPicture(snap, `${ch.name} is ${snap.title.split(': ')[1]}.`, ch))?.ok) n++;
    }
    return n;
  }

  // ---- The tile map ----

  // Tiles being drawn, so two looks at the same tile share one scan; and a small queue so few scans run at once.
  const drawing = new Map();
  let running = 0;
  const waiting = [];
  const slot = () => (running < TILE_AT_ONCE ? (running++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
  const free = () => { running--; const next = waiting.shift(); if (next) { running++; next(); } };

  /** The PNG of tile (tx, ty): x from tx*64 east, z from -ty*64 south (north up). Kept on disk for a while. */
  async function tile(tx, ty) {
    const key = `${tx}_${ty}`;
    const file = join(dir, 'tiles', `${key}.png`);
    const meta = db.json('maps.tiles', {});
    if (meta[key] && now() - meta[key] < TILE_KEEP_MS) {
      try { return await readFile(file); } catch { /* gone: draw it again */ }
    }
    if (drawing.has(key)) return drawing.get(key);
    const job = (async () => {
      try {
        // Rows of the tile run north to south: z from -ty*64 down to -ty*64-63. The store runs z upward, so flip it.
        const z1 = -ty * TILE - (TILE - 1);
        const scan = await area(tx * TILE, z1, TILE, TILE, ISO.YMIN, ISO.YMAX, { tops: true });
        if (!scan) return null;
        const rows = [];
        for (let z = TILE - 1; z >= 0; z--) rows.push(...(scan.cols ?? []).slice(z * TILE, z * TILE + TILE));
        const png = renderTile({ ...scan, cols: rows });
        await mkdir(join(dir, 'tiles'), { recursive: true });
        await writeFile(file, png);
        db.putJson('maps.tiles', { ...db.json('maps.tiles', {}), [key]: now() });
        return png;
      } finally {
        drawing.delete(key);
      }
    })();
    drawing.set(key, job);
    return job;
  }

  /** The isometric chunk (cx, cz) cut at y = top: a PNG in the shared frame, kept like the tiles. */
  async function isoChunk(cx, cz, top) {
    const cut = Math.max(ISO.YMIN + 10, Math.min(ISO.YMAX, Math.round(top)));
    const key = `iso_${cx}_${cz}_${cut}`;
    const file = join(dir, 'tiles', `${key}.png`);
    const meta = db.json('maps.tiles', {});
    if (meta[key] && now() - meta[key] < TILE_KEEP_MS) {
      try { return await readFile(file); } catch { /* gone: draw it again */ }
    }
    if (drawing.has(key)) return drawing.get(key);
    const job = (async () => {
      try {
        const scan = await area(cx * ISO.C, cz * ISO.C, ISO.C, ISO.C, ISO.YMIN, cut);
        if (!scan) return null;
        const png = renderIso(scan, { scale: ISO.A, fixed: { ymin: ISO.YMIN, ymax: ISO.YMAX }, transparent: true }).png;
        await mkdir(join(dir, 'tiles'), { recursive: true });
        await writeFile(file, png);
        db.putJson('maps.tiles', { ...db.json('maps.tiles', {}), [key]: now() });
        return png;
      } finally {
        drawing.delete(key);
      }
    })();
    drawing.set(key, job);
    return job;
  }

  // ---- The explored world: the chunks with map blocks saved, read from the world's map.sqlite ----

  let explored = { at: 0, chunks: [], bounds: null };
  /**
   * The 64-block chunks with any map block saved in the world (Luanti saves every 16-block map block once it is
   * generated), read-only from map.sqlite, at most every 5 minutes. Both layouts: x, y, z columns (worlds made by
   * Luanti 5.12 and later) and the older packed pos.
   */
  function exploredWorld() {
    if (now() - explored.at < 5 * 60_000) return explored;
    const file = join(config.dataDir, 'world', 'map.sqlite');
    if (!existsSync(file)) return explored;
    let world;
    try {
      world = new DatabaseSync(file, { readOnly: true });
      const cols = world.prepare('PRAGMA table_info(blocks)').all().map((c) => c.name);
      const keys = new Set();
      const add = (bx, bz) => keys.add(`${Math.floor((bx * 16) / ISO.C)},${Math.floor((bz * 16) / ISO.C)}`);
      if (cols.includes('x')) {
        for (const r of world.prepare('SELECT DISTINCT x, z FROM blocks').all()) add(r.x, r.z);
      } else {
        const signed = (v) => (v < 2048 ? v : v - 4096);
        for (const { pos } of world.prepare('SELECT pos FROM blocks').all()) {
          let p = Number(pos);
          const x = signed(((p % 4096) + 4096) % 4096);
          p = (p - x) / 4096;
          const y = signed(((p % 4096) + 4096) % 4096);
          p = (p - y) / 4096;
          add(x, signed(((p % 4096) + 4096) % 4096));
        }
      }
      const chunks = [...keys].map((k) => k.split(',').map(Number));
      const xs = chunks.map(([cx]) => cx);
      const zs = chunks.map(([, cz]) => cz);
      explored = { at: now(), chunks, bounds: chunks.length ? { cx1: Math.min(...xs), cz1: Math.min(...zs), cx2: Math.max(...xs), cz2: Math.max(...zs) } : null };
    } catch (err) {
      log.error('reading the explored world failed:', err.message);
    } finally {
      try { world?.close(); } catch { /* closed */ }
    }
    return explored;
  }

  // ---- The store: each chunk's columns as runs (gzipped JSON { cx, cz, names, colors, leaves, cols }) ----

  const runsFile = (cx, cz) => join(dir, 'tiles', `runs_${cx}_${cz}.json.gz`);
  const mem = new Map(); // "cx,cz" -> { names, cols }, the most recently used chunks
  const remember = (k, v) => { mem.delete(k); mem.set(k, v); if (mem.size > 64) mem.delete(mem.keys().next().value); };

  /** Read chunk (cx, cz) from the game into the store. Returns its gzipped JSON, or null. */
  function readChunk(cx, cz) {
    const key = `runs_${cx}_${cz}`;
    if (drawing.has(key)) return drawing.get(key);
    const job = (async () => {
      await slot();
      try {
        if (!game.connected) return null;
        const r1 = await game.act({ type: 'scan', runs: true, x1: cx * ISO.C, z1: cz * ISO.C, w: ISO.C, d: ISO.C, y1: ISO.YMIN, y2: ISO.YMAX });
        if (!r1.ok) return null;
        const scan = JSON.parse(r1.message);
        const names = Array.isArray(scan.names) ? scan.names : [];
        const cols = (scan.cols ?? []).map((c) => c || []);
        const body = gzipSync(JSON.stringify({ cx, cz, names, colors: names.map((n) => colorOf(n)),
          leaves: names.map((n) => /leaves|needles|foliage/.test(n)), cols }));
        await mkdir(join(dir, 'tiles'), { recursive: true });
        await writeFile(runsFile(cx, cz), body);
        // Drawn pictures of this chunk (its flat tile, its isometric cuts) are out of date now.
        const tiles = { ...db.json('maps.tiles', {}), [key]: now() };
        for (const k of Object.keys(tiles)) if (k === `${cx}_${-cz - 1}` || k.startsWith(`iso_${cx}_${cz}_`)) delete tiles[k];
        db.putJson('maps.tiles', tiles);
        remember(`${cx},${cz}`, { names, cols });
        return body;
      } finally {
        free();
        drawing.delete(key);
      }
    })();
    drawing.set(key, job);
    return job;
  }

  /** Chunk (cx, cz) as the page wants it, from the store; read from the game only if it was never mapped. */
  async function chunkRuns(cx, cz) {
    try { return await readFile(runsFile(cx, cz)); } catch { return readChunk(cx, cz); }
  }

  /** Chunk (cx, cz) as { names, cols }, from memory or the store (or the game, the first time); null if none. */
  async function loadChunk(cx, cz) {
    const k = `${cx},${cz}`;
    if (mem.has(k)) return mem.get(k);
    const gz = await chunkRuns(cx, cz).catch(() => null);
    if (!gz) return null;
    const { names, cols } = JSON.parse(gunzipSync(gz).toString());
    remember(k, { names, cols });
    return mem.get(k);
  }

  /**
   * An area from the store, in the shape of the mod's scan (so renderIso and renderTile draw it as before): per column
   * top down, the blocks a face of which shows (y, name index pairs); or with `tops`, the ground and any canopy over it.
   * Marks: the characters and players in it. Null when nothing of it is mapped.
   */
  async function area(x1, z1, w, d, lo, hi, { tops = false } = {}) {
    const y1 = Math.max(ISO.YMIN, lo);
    const y2 = Math.min(ISO.YMAX, hi);
    const W = w + 1;
    const D = d + 1;
    const H = y2 - y1 + 1;
    const grid = new Int32Array(W * D * H).fill(-1);
    const names = [];
    const gid = new Map();
    const id = (n) => { if (!gid.has(n)) { gid.set(n, names.length); names.push(n); } return gid.get(n); };
    let found = 0;
    const C = ISO.C;
    for (let cz = Math.floor(z1 / C); cz <= Math.floor((z1 + d) / C); cz++) {
      for (let cx = Math.floor(x1 / C); cx <= Math.floor((x1 + w) / C); cx++) {
        const ch = await loadChunk(cx, cz);
        if (!ch) continue;
        found++;
        const ids = ch.names.map(id);
        for (let lz = 0; lz < C; lz++) {
          const z = cz * C + lz - z1;
          if (z < 0 || z >= D) continue;
          for (let lx = 0; lx < C; lx++) {
            const x = cx * C + lx - x1;
            if (x < 0 || x >= W) continue;
            const col = ch.cols[lz * C + lx];
            if (!col) continue;
            for (let i = 0; i + 2 < col.length; i += 3) {
              const n = ids[col[i + 2]];
              for (let y = Math.min(col[i], y2); y > col[i] - col[i + 1] && y >= y1; y--) grid[(z * W + x) * H + (y - y1)] = n;
            }
          }
        }
      }
    }
    if (!found) return null;
    const clear = names.map((n) => SEE_THROUGH.test(n));
    const at = (x, y, z) => (y < y1 || y > y2 ? -1 : grid[(z * W + x) * H + (y - y1)]);
    const open = (c) => c < 0 || clear[c];
    const cols = [];
    for (let z = 0; z < d; z++) {
      for (let x = 0; x < w; x++) {
        let h = null;
        for (let y = y2; y >= y1; y--) if (at(x, y, z) >= 0) { h = y; break; }
        if (h === null) { cols.push(false); continue; }
        if (tops) {
          let g = h;
          for (let y = h; y >= y1; y--) { const c = at(x, y, z); if (c >= 0 && !clear[c]) { g = y; break; } }
          cols.push(g < h ? [g, at(x, g, z), at(x, h, z)] : [g, at(x, g, z)]);
          continue;
        }
        const col = [];
        const edge = x === w - 1 || z === d - 1;
        for (let y = h; y >= y1; y--) {
          const c = at(x, y, z);
          if (c >= 0 && (y === y2 || edge || open(at(x, y + 1, z)) || open(at(x, y, z + 1)) || open(at(x + 1, y, z)))) col.push(y, c);
        }
        cols.push(col);
      }
    }
    const inside = (p) => p.x >= x1 && p.x < x1 + w && p.z >= z1 && p.z < z1 + d;
    const marks = [
      ...(game.bodies ?? []).filter(inside).map((b) => ({ id: b.id, x: Math.round(b.x), y: Math.round(b.y), z: Math.round(b.z) })),
      ...game.players.filter((p) => p.pos && inside(p.pos)).map((p) => ({ player: p.name, x: p.pos.x, y: p.pos.y, z: p.pos.z })),
    ];
    return { x1, z1, w, d, y1, names, cols, marks };
  }

  // ---- Keeping the store up to date ----

  // "cx,cz": chunks something was done to since they were read. Kept in the database: a restart must not forget them
  // (it did, and two fields made just before a deploy never showed on the map).
  const dirty = new Set(db.json('maps.dirty', []));
  const saveDirty = () => db.putJson('maps.dirty', [...dirty].slice(-2000));
  const chunkOf = (x, z) => `${Math.floor(x / ISO.C)},${Math.floor(z / ISO.C)}`;
  /** The chunks a box of columns touches. */
  const chunksIn = (x1, z1, x2, z2) => {
    const out = [];
    for (let cx = Math.floor(Math.min(x1, x2) / ISO.C); cx <= Math.floor(Math.max(x1, x2) / ISO.C); cx++) {
      for (let cz = Math.floor(Math.min(z1, z2) / ISO.C); cz <= Math.floor(Math.max(z1, z2) / ISO.C); cz++) out.push(`${cx},${cz}`);
    }
    return out;
  };
  game.onAct?.((a) => {
    const before = dirty.size;
    if (a.type === 'place') for (const n of a.nodes ?? []) dirty.add(chunkOf(n.x, n.z));
    if (['farm', 'harvest', 'clear', 'box'].includes(a.type)) for (const k of chunksIn(a.x1, a.z1, a.x2, a.z2)) dirty.add(k);
    if (dirty.size !== before) saveDirty();
  });
  let lastSurvey = 0;
  let surveying = false;

  /**
   * Every 5 minutes, when anything happened: read again the chunks that were built on, and those around each player
   * in the game (they dig and build by hand). Nothing happened: nothing is read. Returns how many chunks it read.
   */
  async function survey() {
    if (surveying || !game.connected || now() - lastSurvey < SURVEY_MS) return 0;
    for (const p of game.players) {
      if (!p.pos) continue;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) dirty.add(chunkOf(p.pos.x + dx * ISO.C, p.pos.z + dz * ISO.C));
    }
    if (!dirty.size) return 0;
    surveying = true;
    lastSurvey = now();
    let n = 0;
    try {
      for (const k of [...dirty].slice(0, SURVEY_MAX)) {
        const [cx, cz] = k.split(',').map(Number);
        // Kept on the list until it is read: a failed read is tried again next time.
        if (await readChunk(cx, cz).catch(() => null)) { n++; dirty.delete(k); }
      }
    } finally {
      surveying = false;
      saveDirty();
    }
    if (n) log.log(`map: ${n} chunks brought up to date`);
    return n;
  }

  /**
   * Read an area again from the game now (owner, 2026-10-27: "Is there a way I can request current map data on map
   * page?"): the chunks under columns x1, z1 to x2, z2, at most REFRESH_MAX. Returns the chunk keys read.
   */
  const REFRESH_MAX = 16;
  async function refresh(x1, z1, x2, z2) {
    const keys = chunksIn(x1, z1, x2, z2).slice(0, REFRESH_MAX);
    const read = [];
    for (const k of keys) {
      const [cx, cz] = k.split(',').map(Number);
      if (await readChunk(cx, cz).catch(() => null)) { read.push(k); dirty.delete(k); }
    }
    saveDirty();
    return read;
  }

  /** How fresh the store is: chunks kept and their ages, chunks waiting to be read, the last survey. */
  function storeStatus() {
    const tiles = db.json('maps.tiles', {});
    const ages = Object.entries(tiles).filter(([k]) => k.startsWith('runs_')).map(([k, t]) => [k.slice(5).replace('_', ','), t]);
    const at = ages.map(([, t]) => t);
    return { chunks: ages.length, newest: at.length ? new Date(Math.max(...at)).toISOString() : null,
      oldest: at.length ? new Date(Math.min(...at)).toISOString() : null, waiting: [...dirty],
      lastSurvey: lastSurvey ? new Date(lastSurvey).toISOString() : null, everyMinutes: SURVEY_MS / 60_000,
      readAt: Object.fromEntries(ages.sort((x, y) => y[1] - x[1]).slice(0, 40).map(([k, t]) => [k, new Date(t).toISOString()])) };
  }

  /** Where everyone is: characters (with their colours) and players online. */
  function where() {
    const byId = Object.fromEntries(characters().map((c) => [c.id, c]));
    return {
      characters: (game.bodies ?? []).filter((b) => byId[b.id]).map((b) => ({ name: byId[b.id].name, color: byId[b.id].dressColor,
        x: b.x, y: b.y, z: b.z, doing: byId[b.id].project?.title ?? null })),
      players: game.players.filter((p) => p.pos).map((p) => ({ name: p.name, x: p.pos.x, y: p.pos.y, z: p.pos.z })),
    };
  }

  /**
   * The pictures `who` asks for: everyone (empty), a character by (the start of) her name, or a spot as "x z". Returns
   * { pictures: [{ png, file, text, ch }] } or { error }, at most one ask every 30 seconds.
   */
  async function pictures(who = '') {
    if (now() - lastMapCommand < MAP_COMMAND_GAP_MS) return { error: 'Give the camera a moment: one picture every 30 seconds.' };
    lastMapCommand = now();
    const arg = String(who ?? '').trim();
    const xz = /^(-?\d+)[\s,]+(-?\d+)$/.exec(arg);
    if (xz) {
      const out = await render({ x: Number(xz[1]), z: Number(xz[2]) });
      return out.error ? { error: `No picture: ${out.error}` }
        : { pictures: [{ png: out.png, file: 'spot.png', text: `Around ${xz[1]}, ${xz[2]}\n${MORE(config.publicUrl)}` }] };
    }
    const all = characters();
    const pick = arg ? all.filter((c) => c.name.toLowerCase().startsWith(arg.toLowerCase())) : all;
    if (!pick.length) return { error: `Nobody called ${arg}. Try /picture, /picture who:<name> or /picture who:<x> <z>.` };
    const out = [];
    for (const ch of pick.slice(0, 3)) {
      const snap = await snapshot(ch);
      if (snap) out.push({ png: snap.png, file: snap.file, ch, text: `${snap.title}\n${MORE(config.publicUrl)}` });
    }
    return out.length ? { pictures: out } : { error: `${pick.map((c) => c.name).join(' and ')} ${pick.length === 1 ? 'is' : 'are'} not in the world right now.` };
  }

  /** The /map routes. Returns true when it answered. */
  async function handle(req, res, url, ip) {
    if (url.pathname === '/map' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      const x = Number(url.searchParams.get('x'));
      const z = Number(url.searchParams.get('z'));
      const spot = url.searchParams.has('x') && Number.isFinite(x) && Number.isFinite(z) && Math.abs(x) < 31000 && Math.abs(z) < 31000
        ? { x: Math.round(x), y: 10, z: Math.round(z) } : null;
      res.end(page(url.searchParams.get('view') === 'flat' ? 'flat' : 'iso', spot));
      return true;
    }
    // The page's Refresh button: read the chunks in view again, now; once a minute per address.
    if (url.pathname === '/map/refresh' && req.method === 'POST') {
      if (now() - (lastRefresh.get(ip) ?? 0) < REFRESH_GAP_MS) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
        res.end(JSON.stringify({ error: 'One refresh a minute: try again shortly.' }));
        return true;
      }
      const b = Object.fromEntries(['x1', 'z1', 'x2', 'z2'].map((k) => [k, Number(url.searchParams.get(k))]));
      if (!Object.values(b).every((v) => Number.isFinite(v) && Math.abs(v) < 31000)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Give x1, z1, x2, z2.' }));
        return true;
      }
      lastRefresh.set(ip, now());
      if (lastRefresh.size > 5000) lastRefresh.clear();
      const read = game.connected ? await refresh(b.x1, b.z1, b.x2, b.z2) : [];
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ read, game: game.connected }));
      return true;
    }
    const t = /^\/map\/tiles\/(-?\d{1,4})\/(-?\d{1,4})\.png$/.exec(url.pathname);
    if (t && req.method === 'GET') {
      const png = await tile(Number(t[1]), Number(t[2])).catch(() => null);
      if (!png) {
        res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '30' });
        res.end('The game is not answering; try again soon.');
        return true;
      }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=300' });
      res.end(png);
      return true;
    }
    const runs = /^\/map\/chunk\/(-?\d{1,4})\/(-?\d{1,4})\.json$/.exec(url.pathname);
    if (runs && req.method === 'GET') {
      const gz = await chunkRuns(Number(runs[1]), Number(runs[2])).catch(() => null);
      if (!gz) {
        res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '30' });
        res.end('The game is not answering; try again soon.');
        return true;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'cache-control': 'public, max-age=240' });
      res.end(gz);
      return true;
    }
    const iso = /^\/map\/iso\/(-?\d{1,4})\/(-?\d{1,4})\.png$/.exec(url.pathname);
    if (iso && req.method === 'GET') {
      const top = Number(url.searchParams.get('top') ?? ISO.YMAX);
      const png = Number.isFinite(top) ? await isoChunk(Number(iso[1]), Number(iso[2]), top).catch(() => null) : null;
      if (!png) {
        res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '30' });
        res.end('The game is not answering; try again soon.');
        return true;
      }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=300' });
      res.end(png);
      return true;
    }
    if (url.pathname === '/map/explored.json' && req.method === 'GET') {
      const e = exploredWorld();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' });
      res.end(JSON.stringify({ chunks: e.chunks, bounds: e.bounds }));
      return true;
    }
    if (url.pathname === '/map/where.json' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(where()));
      return true;
    }
    const img = /^\/map\/img\/([a-z0-9-]{1,40}\.png)$/.exec(url.pathname);
    if (img && req.method === 'GET') {
      try {
        const png = await readFile(join(dir, img[1]));
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=60' });
        res.end(png);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('No such picture.');
      }
      return true;
    }
    if (url.pathname === '/map/render' && req.method === 'GET') {
      const x = Number(url.searchParams.get('x'));
      const z = Number(url.searchParams.get('z'));
      if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > 30000 || Math.abs(z) > 30000) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('Give x and z: /map/render?x=10&z=-20 (optional y, and r up to 64).');
        return true;
      }
      if (now() - (lastAsk.get(ip) ?? 0) < RENDER_GAP_MS) {
        res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '15' });
        res.end('One picture every 15 seconds.');
        return true;
      }
      lastAsk.set(ip, now());
      if (lastAsk.size > 5000) lastAsk.clear();
      const y = url.searchParams.has('y') ? Number(url.searchParams.get('y')) : null;
      const out = await render({ x, z, y, r: Number(url.searchParams.get('r')) || RADIUS });
      if (out.error) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end(out.error);
        return true;
      }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      res.end(out.png);
      return true;
    }
    return false;
  }

  function page(view = 'iso', spot = null) {
    legendCast = characters();
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const byId = Object.fromEntries(characters().map((c) => [c.id, c]));
    const cards = Object.values(kept()).sort((x, y) => y.at - x.at).map((m) => {
      const c = byId[m.key];
      const mins = Math.max(0, Math.round((now() - m.at) / 60000));
      return `<figure><img src="/map/img/${esc(m.file)}?v=${m.at}" alt="${esc(m.title)}" loading="lazy">
        <figcaption><b style="color:${esc(c?.chatColor ?? '#8fd16a')}">${esc(c?.name ?? m.key)}</b> ${esc(m.title.split(': ').slice(1).join(': '))}
        <span>at ${m.x}, ${m.y}, ${m.z} · ${mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`}</span></figcaption></figure>`;
    }).join('');
    // Where to open the map: the spot asked for (switching views keeps it), else the first character, else 0, 0.
    const first = spot ?? (game.bodies ?? [])[0] ?? { x: 0, y: 10, z: 0 };
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blocky Stuff map</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin="">
<style>
  .copy { margin-left: 6px; font: inherit; font-size: 13px; padding: 3px 10px; border-radius: 999px; border: 0; background: #2f6d3a; color: #fff; cursor: pointer; }
:root { color-scheme: dark; --bg: #12150f; --panel: #1b2217; --line: #344030; --text: #f4f7ef; --muted: #a9b89a; --accent: #8fd16a; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 1200px; margin: 0 auto; padding: 20px 16px 40px; }
h1 { color: var(--accent); font-size: 24px; margin: 0 0 4px; } h2 { color: var(--accent); font-size: 18px; margin: 28px 0 10px; }
p { color: var(--muted); margin: 0 0 14px; } a { color: var(--accent); }
#map { height: min(72vh, 680px); border-radius: 10px; border: 1px solid var(--line); background: #142038; }
.leaflet-container { font: 13px system-ui, sans-serif; }
.who { background: rgba(20, 24, 18, .85); color: #fff; border: 0; border-radius: 6px; padding: 2px 6px; font-weight: 600; box-shadow: none; }
.who::before { display: none; }
.bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 0 0 10px; }
.bar button { font: inherit; font-size: 14px; border: 1px solid var(--line); background: var(--panel); color: var(--text); padding: 6px 12px; cursor: pointer; min-height: 36px; }
.seg { display: inline-flex; } .seg button:first-child { border-radius: 999px 0 0 999px; } .seg button:last-child { border-radius: 0 999px 999px 0; border-left: 0; }
.seg button.on { background: var(--accent); color: #12150f; border-color: var(--accent); }
.bar button.act { border-radius: 999px; } .bar button:disabled { opacity: .5; cursor: default; }
#refreshNote { color: var(--muted); font-size: 14px; }
.cut, .toggles { display: flex; gap: 12px 18px; align-items: center; flex-wrap: wrap; margin: 0 0 10px; color: var(--muted); }
.tog { display: inline-flex; gap: 6px; align-items: center; color: var(--text); cursor: pointer; white-space: nowrap; } .tog input { accent-color: var(--accent); width: 16px; height: 16px; }
.cut input[type=range]:disabled { opacity: .4; }
.cut input { flex: 1 1 200px; max-width: 420px; accent-color: var(--accent); } .cut output { font: 600 14px ui-monospace, monospace; color: var(--text); min-width: 120px; }
.legend { background: rgba(20, 24, 18, .9); color: #fff; padding: 6px 10px; border-radius: 8px; font: 12px system-ui, sans-serif; max-width: 200px; }
.legend summary { cursor: pointer; font-weight: 600; } .legend .leg { display: grid; gap: 3px; margin-top: 6px; }
.legend .leg span { display: flex; gap: 8px; align-items: center; } .legend i { width: 12px; height: 12px; border-radius: 3px; display: inline-block; flex: none; }
.legend hr { border: 0; border-top: 1px solid #3a4636; margin: 4px 0; width: 100%; }
.coords { background: rgba(20, 24, 18, .85); color: #fff; padding: 4px 8px; border-radius: 6px; font: 12px ui-monospace, monospace; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 520px), 1fr)); gap: 16px; }
figure { margin: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
figure img { display: block; width: 100%; height: auto; image-rendering: pixelated; }
figcaption { padding: 10px 12px; display: grid; gap: 2px; } figcaption span { color: var(--muted); font-size: 13px; }
code { background: #232a1f; padding: 1px 6px; border-radius: 4px; }
</style></head><body><main>
<h1>${esc(config.serverName)} map</h1>
<div class="bar"><span class="seg"><button id="toIso"${view === 'iso' ? ' class="on"' : ''}>Isometric</button><button id="toFlat"${view === 'flat' ? ' class="on"' : ''}>Top-down</button></span>
<button id="refresh" class="act">↻ Refresh this view</button><span id="refreshNote"></span></div>
${view === 'iso' ? `<div class="cut"><label class="tog"><input type="checkbox" id="cutOn"> Cut at height</label>
<input type="range" id="cut" min="${ISO.YMIN + 1}" max="${ISO.YMAX}" step="1" value="${ISO.YMAX}"><output id="cutOut">everything</output></div>
<div class="toggles"><label class="tog"><input type="checkbox" id="show_trees"> Trees</label><label class="tog"><input type="checkbox" id="show_characters"> Characters</label>
<label class="tog"><input type="checkbox" id="show_players"> Players</label><label class="tog"><input type="checkbox" id="show_names"> Names</label>
<label class="tog"><input type="checkbox" id="show_doing"> What they're doing</label></div>` : ''}
<div id="map"></div>
<h2>What the characters are up to</h2>
<p>Isometric pictures of each character, aimed at where she is, refreshed every 20 minutes.</p>
<div class="grid">${cards || '<p>No pictures yet: they come once a character is in the world.</p>'}</div></main>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>
<script>
// Copy a spot's coordinates from its popup (owner, 2026-10-27: "Would be nice to just hit copy on the location popup").
function copyButton(text) { return '<button class="copy" data-copy="' + text + '">Copy</button>'; }
document.addEventListener('click', async (ev) => {
  const b = ev.target.closest && ev.target.closest('button.copy');
  if (!b) return;
  ev.stopPropagation();
  const text = b.dataset.copy;
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); } catch { /* nothing more to try */ }
    t.remove();
  }
  b.textContent = 'Copied!';
  setTimeout(() => { b.textContent = 'Copy'; }, 1500);
}, true);
${view === 'iso' ? isoScript(first) : flatScript(first)}
// ---- Switching views (at the same spot) and refreshing what is in view ----
const goTo = (v) => { const [x, z] = centerXZ(); location.href = '/map?' + (v === 'flat' ? 'view=flat&' : '') + 'x=' + x + '&z=' + z; };
document.getElementById('toIso').onclick = () => { if (${view === 'flat'}) goTo('iso'); };
document.getElementById('toFlat').onclick = () => { if (${view === 'iso'}) goTo('flat'); };
document.getElementById('refresh').onclick = async () => {
  const btn = document.getElementById('refresh'), note = document.getElementById('refreshNote');
  // The 4 by 4 chunks (256 by 256 blocks) round the middle of the view.
  const [x, z] = centerXZ(), cx = Math.floor(x / 64), cz = Math.floor(z / 64);
  btn.disabled = true; note.textContent = 'Reading the area from the game…';
  try {
    const r = await fetch('/map/refresh?x1=' + (cx - 2) * 64 + '&z1=' + (cz - 2) * 64 + '&x2=' + ((cx + 2) * 64 - 1) + '&z2=' + ((cz + 2) * 64 - 1), { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) note.textContent = j.error || 'Could not refresh right now.';
    else if (!j.game) note.textContent = 'The game is not running: showing the last map.';
    else { afterRefresh(j.read); note.textContent = 'Up to date (' + j.read.length + ' areas read just now).'; }
  } catch { note.textContent = 'Could not reach the server.'; }
  setTimeout(() => { btn.disabled = false; }, 60000);
};
</script></body></html>`;
  }

  return { render, snapshot, tick, survey, refresh, storeStatus, pictures, handle, settings, page, postNow, tile, isoChunk, chunkRuns, where };
}

// The flat map's script: one map unit is one block, x east and z north as the map's up; tiles are 64 blocks at zoom 2.
function flatScript(first) {
  return `const map = L.map('map', { crs: L.CRS.Simple, minZoom: 0, maxZoom: 5, zoomSnap: 0.5, attributionControl: false })
  .setView([${Number(first.z) || 0}, ${Number(first.x) || 0}], 3);
const tiles = L.tileLayer('/map/tiles/{x}/{y}.png?v={v}', { tileSize: 256, minNativeZoom: 2, maxNativeZoom: 2, noWrap: true, v: 0,
  errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }).addTo(map);
const at = (x, y, z) => [z, x];
const centerXZ = () => { const c = map.getCenter(); return [Math.round(c.lng), Math.round(c.lat)]; };
// After a refresh: every tile fetched again (the server drew the refreshed ones anew).
const afterRefresh = () => { tiles.options.v = Date.now(); tiles.redraw(); };
${markersScript()}
const Coords = L.Control.extend({ onAdd() { this.el = L.DomUtil.create('div', 'coords'); this.el.textContent = 'x, z'; return this.el; } });
const coords = new Coords({ position: 'bottomleft' }).addTo(map);
map.on('mousemove', (e) => { coords.el.textContent = 'x ' + Math.floor(e.latlng.lng) + ', z ' + Math.floor(e.latlng.lat); });
map.on('click', (e) => { const x = Math.floor(e.latlng.lng), z = Math.floor(e.latlng.lat);
  L.popup().setLatLng(e.latlng).setContent('x ' + x + ', z ' + z + ' ' + copyButton(x + ', ' + z)).openOn(map); });`;
}

// The isometric map's script. The page draws the map itself (owner, 2026-10-27: "ship renderer on front end"): it
// fetches each explored chunk's columns once (/map/chunk, runs of one block), keeps them, and draws them into a canvas
// per chunk, so the cut (1 block at a time) and the toggles redraw at once without asking the server. One map unit is
// one pixel of the drawing at zoom 0; a block at (x, y, z) sits at GX = (x - z) * A, GY = (x + z) * A / 2 - y * A, the
// map's up is -GY, and each chunk's canvas is placed from ISO alone, the nearer (larger cx + cz) over the farther.
function isoScript(first) {
  const { A, YMIN, YMAX, C } = ISO;
  return `const A = ${A}, YMIN = ${YMIN}, YMAX = ${YMAX}, C = ${C}, NY = YMAX - YMIN + 1;
const W = 2 * C * A + 2 * A, H = Math.round(C * A + (YMAX - YMIN + 3) * A + 3 * A), OX = C * A, OY = (YMAX - YMIN + 2) * A;
const gx = (x, z) => (x - z) * A, gy = (x, y, z) => (x + z) * A / 2 - y * A;
// The map's longitude is the drawing's x flipped (-gx): drawn as computed, the world came out mirrored (owner,
// 2026-10-27: "the bridge sways to the right, the map sways to the left").
const at = (x, y, z) => [-(gy(x, y, z) + A / 2), -(gx(x, z) + A)];
const map = L.map('map', { crs: L.CRS.Simple, minZoom: -4, maxZoom: 3, zoomSnap: 0.5, attributionControl: false,
  maxBoundsViscosity: 1 }).setView(at(${Number(first.x) || 0}, ${Number(first.y) || 10}, ${Number(first.z) || 0}), 0);
const origin = (cx, cz) => { const x1 = cx * C, z1 = cz * C; return [(x1 - z1) * A - OX, (x1 + z1) * A / 2 - YMIN * A - OY]; };

// What to show: the cut (off = everything), trees, characters, players, names. Remembered on this device.
const view = { cut: false, cutAt: YMAX, trees: true, characters: true, players: true, names: true, doing: true };
try { Object.assign(view, JSON.parse(localStorage.getItem('blocky.mapview') || '{}')); } catch {}
const save = () => { try { localStorage.setItem('blocky.mapview', JSON.stringify(view)); } catch {} };

// ---- Drawing a chunk ----
// One block's sprite, 2A square: which face each pixel is (1 top, 2 south, 3 east) and whether it is on its edge.
const SP = (() => {
  const w = 2 * A, face = new Uint8Array(w * w), edge = new Uint8Array(w * w);
  const inside = (px, py, poly) => { let hit = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit; } return hit; };
  const polys = [[[A, 0], [w, A / 2], [A, A], [0, A / 2]], [[0, A / 2], [A, A], [A, w], [0, w - A / 2]], [[A, A], [w, A / 2], [w, w - A / 2], [A, w]]];
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) face[y * w + x] = polys.findIndex((p) => inside(x + 0.5, y + 0.5, p)) + 1;
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) { const f = face[y * w + x]; if (!f) continue;
    edge[y * w + x] = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].some(([nx, ny]) => nx < 0 || ny < 0 || nx >= w || ny >= w || face[ny * w + nx] !== f) ? 1 : 0; }
  return { w, face, edge };
})();
const SHADE = [0, 1, 0.8, 0.64];

// A chunk's columns as a dense block grid: (z * C + x) * NY + (y - YMIN) -> name index + 1 (0 is air).
function grid(data) {
  const g = new Uint16Array(C * C * NY);
  data.cols.forEach((col, i) => { for (let k = 0; k + 2 < col.length; k += 3) {
    const top = col[k], len = col[k + 1], id = col[k + 2] + 1;
    for (let y = top; y > top - len; y--) if (y >= YMIN && y <= YMAX) g[i * NY + (y - YMIN)] = id; } });
  return g;
}

// Draw a chunk under the current view into a fresh canvas; returns a PNG URL for an image overlay.
function draw(chunk) {
  const { g, data } = chunk;
  const cut = view.cut ? view.cutAt : YMAX;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const px = img.data;
  const leaf = data.leaves;
  const block = (x, y, z) => (x >= C || z >= C || y > cut || y < YMIN ? 0 : g[(z * C + x) * NY + (y - YMIN)]);
  const open = (x, y, z) => { const id = block(x, y, z); return id === 0 || leaf[id - 1]; };
  const blit = (sx, sy, rgba) => {
    const alpha = (rgba[3] ?? 255) / 255;
    for (let yy = 0; yy < SP.w; yy++) { const ty = sy + yy; if (ty < 0 || ty >= H) continue;
      for (let xx = 0; xx < SP.w; xx++) { const f = SP.face[yy * SP.w + xx]; if (!f) continue; const tx = W - 1 - (sx + xx); if (tx < 0 || tx >= W) continue;
        const k = SHADE[f] * (SP.edge[yy * SP.w + xx] ? 0.86 : 1), o = (ty * W + tx) * 4, da = px[o + 3] / 255, oa = alpha + da * (1 - alpha);
        for (let c = 0; c < 3; c++) px[o + c] = oa ? (Math.min(255, rgba[c] * k) * alpha + px[o + c] * da * (1 - alpha)) / oa : 0;
        px[o + 3] = oa * 255; } }
  };
  for (let s = 0; s <= 2 * C - 2; s++) {
    for (let x = Math.max(0, s - C + 1); x <= Math.min(C - 1, s); x++) {
      const z = s - x, base = (z * C + x) * NY, edge = x === C - 1 || z === C - 1;
      for (let y = YMIN; y <= cut; y++) {
        const id = g[base + (y - YMIN)];
        if (!id) continue;
        if (leaf[id - 1] && !view.trees) continue;
        if (!(y === cut || edge || open(x, y + 1, z) || open(x, y, z + 1) || open(x + 1, y, z))) continue;
        blit(OX + (x - z) * A, OY + ((x + z) * A) / 2 - (y - YMIN) * A, data.colors[id - 1]);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return new Promise((done) => canvas.toBlob((b) => done(b ? URL.createObjectURL(b) : null)));
}

// ---- Which chunks, fetched once and kept ----
let known = null;
const chunks = new Map(); // "cx,cz" -> { data, g, at, overlay, drawn }
const FRESH = 5 * 60 * 1000;
let fetching = 0;
const queue = [];
const turn = () => (fetching < 4 ? (fetching++, Promise.resolve()) : new Promise((r) => queue.push(r)));
const done = () => { fetching--; const next = queue.shift(); if (next) { fetching++; next(); } };
async function fetchChunk(cx, cz, fresh = false) {
  await turn();
  try { const r = await fetch('/map/chunk/' + cx + '/' + cz + '.json', fresh ? { cache: 'reload' } : undefined); return r.ok ? await r.json() : null; } catch { return null; } finally { done(); }
}
// The block (x, z) at the middle of the view, taking the ground as about y 10.
const centerXZ = () => { const c = map.getCenter(); const u = (-c.lng - A) / A, v = (-c.lat - A / 2 + 10 * A) * 2 / A; return [Math.round((u + v) / 2), Math.round((v - u) / 2)]; };
// After a refresh: the chunks read anew are fetched past the browser's cache and drawn again.
function afterRefresh(keys) {
  for (const key of keys) {
    const chunk = chunks.get(key);
    if (!chunk || !chunk.g) continue;
    const [cx, cz] = key.split(',').map(Number);
    chunk.at = Date.now();
    fetchChunk(cx, cz, true).then((data) => { if (data) { chunk.data = data; chunk.g = grid(data); show(cx, cz, chunk); } });
  }
}
async function show(cx, cz, chunk) {
  const src = await draw(chunk);
  if (!src) return;
  const [ox, oy] = origin(cx, cz);
  if (chunk.overlay) { const old = chunk.src; chunk.overlay.setUrl(src); setTimeout(() => URL.revokeObjectURL(old), 2000); }
  else chunk.overlay = L.imageOverlay(src, [[-oy, -(ox + W)], [-(oy + H), -ox]], { zIndex: 1000 + cx + cz, interactive: false }).addTo(map);
  chunk.src = src;
}
function wanted() {
  const b = map.getBounds();
  const gx1 = -b.getEast(), gx2 = -b.getWest(), gy1 = -b.getNorth(), gy2 = -b.getSouth();
  const umin = gx1 / A - 2, umax = gx2 / A + 2, vmin = 2 * gy1 / A + 2 * YMIN - 4, vmax = 2 * gy2 / A + 2 * YMAX + 4;
  const out = [];
  for (let p = Math.floor((umin - C) / C); p <= Math.ceil((umax + C) / C); p++) {
    for (let q = Math.floor((vmin - 2 * C) / C); q <= Math.ceil(vmax / C); q++) {
      if ((p + q) % 2 !== 0) continue;
      const cx = (p + q) / 2, cz = (q - p) / 2;
      if (known && !known.has(cx + ',' + cz)) continue;
      const [ox, oy] = origin(cx, cz);
      if (ox > gx2 || ox + W < gx1 || oy > gy2 || oy + H < gy1) continue;
      out.push([cx, cz]);
    }
  }
  return out.slice(0, 80);
}
function load() {
  for (const [cx, cz] of wanted()) {
    const key = cx + ',' + cz;
    if (chunks.has(key)) continue;
    const chunk = { at: Date.now() };
    chunks.set(key, chunk);
    fetchChunk(cx, cz).then((data) => {
      if (!data) { chunks.delete(key); return; }
      chunk.data = data; chunk.g = grid(data); chunk.at = Date.now();
      show(cx, cz, chunk);
    });
  }
}
map.on('moveend', load);
// Every minute: chunks in view over 5 minutes old are fetched again and redrawn in place.
setInterval(() => {
  const b = map.getBounds();
  for (const [key, chunk] of chunks) {
    if (!chunk.overlay || Date.now() - chunk.at < FRESH || !b.intersects(chunk.overlay.getBounds())) continue;
    chunk.at = Date.now();
    const [cx, cz] = key.split(',').map(Number);
    fetchChunk(cx, cz).then((data) => { if (data) { chunk.data = data; chunk.g = grid(data); show(cx, cz, chunk); } });
  }
}, 60 * 1000);
// Redraw every loaded chunk (after the cut or trees change), a few at a time so the page stays responsive.
let redrawing = null;
function redrawAll() {
  clearTimeout(redrawing);
  const list = [...chunks.entries()].filter(([, c]) => c.g);
  const step = () => { for (const [key, c] of list.splice(0, 4)) { const [cx, cz] = key.split(',').map(Number); show(cx, cz, c); }
    if (list.length) redrawing = setTimeout(step, 0); };
  redrawing = setTimeout(step, 30);
}

// Only the explored world: the chunks with anything saved, and no panning past their bounds.
fetch('/map/explored.json').then((r) => r.json()).then((e) => {
  if (e.bounds) {
    known = new Set(e.chunks.map(([cx, cz]) => cx + ',' + cz));
    const { cx1, cz1, cx2, cz2 } = e.bounds;
    const corners = [[cx1, cz1], [cx2, cz1], [cx1, cz2], [cx2, cz2]].map(([cx, cz]) => origin(cx, cz));
    const west = Math.min(...corners.map(([ox]) => ox)), east = Math.max(...corners.map(([ox]) => ox + W));
    const north = Math.min(...corners.map(([, oy]) => oy)), south = Math.max(...corners.map(([, oy]) => oy + H));
    const box = L.latLngBounds([[-north, -east], [-south, -west]]);
    map.setMaxBounds(box.pad(0.05));
    map.setMinZoom(Math.min(0, map.getBoundsZoom(box) - 0.5));
  }
  load();
}).catch(() => load());

// Click a block: its coordinates and what it is. The click is a line of sight into the drawing: from the cut down, the
// first block whose top sits under the pointer (from the chunks already in this page).
const blockAt = (x, y, z) => {
  const cx = Math.floor(x / C), cz = Math.floor(z / C), chunk = chunks.get(cx + ',' + cz);
  if (!chunk || !chunk.g || y < YMIN || y > YMAX) return null;
  const id = chunk.g[((z - cz * C) * C + (x - cx * C)) * NY + (y - YMIN)];
  if (!id || (chunk.data.leaves[id - 1] && !view.trees)) return null;
  return chunk.data.names[id - 1];
};
map.on('click', (e) => {
  const gxc = -e.latlng.lng, gyc = -e.latlng.lat;
  const top = view.cut ? view.cutAt : YMAX;
  for (let y = top; y >= YMIN; y--) {
    const u = (gxc - A) / A, v = ((gyc - A / 2) + y * A) * 2 / A;
    const x = Math.round((u + v) / 2), z = Math.round((v - u) / 2);
    const name = blockAt(x, y, z);
    if (name) {
      L.popup({ className: 'where' }).setLatLng(e.latlng).setContent('x ' + x + ', y ' + y + ', z ' + z + ' ' + copyButton(x + ', ' + y + ', ' + z)
        + '<br><small>' + name + '</small>').openOn(map);
      return;
    }
  }
  L.popup({ className: 'where' }).setLatLng(e.latlng).setContent('Nothing here (not explored, or air).').openOn(map);
});

// ---- The controls ----
const $ = (id) => document.getElementById(id);
const cutBox = $('cutOn'), cutRange = $('cut'), cutOut = $('cutOut');
const setCutText = () => { cutOut.textContent = view.cut ? 'y ' + view.cutAt + ' and below' : 'everything'; cutRange.disabled = !view.cut; };
cutBox.checked = view.cut; cutRange.value = view.cutAt; setCutText();
cutBox.addEventListener('change', () => { view.cut = cutBox.checked; setCutText(); save(); redrawAll(); });
cutRange.addEventListener('input', () => { view.cutAt = Number(cutRange.value); setCutText(); save(); redrawAll(); });
for (const k of ['trees', 'characters', 'players', 'names', 'doing']) {
  const box = $('show_' + k);
  box.checked = view[k];
  box.addEventListener('change', () => { view[k] = box.checked; save(); if (k === 'trees') redrawAll(); else where(); });
}
${markersScript()}`;
}

// The legend's body: a dot per character in her colour, players, and swatches of the common ground (from the same
// colour table the map is drawn with).
let legendCast = [];
function legendHtml() {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dot = (color) => `<i style="background:${color};border-radius:50%"></i>`;
  const sw = (name) => { const [r, g, b] = colorOf(name); return `<i style="background:rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})"></i>`; };
  const ground = [['default:dirt_with_grass', 'Grass'], ['default:dirt_with_coniferous_litter', 'Forest floor'], ['default:pine_needles', 'Pine trees'],
    ['default:sand', 'Sand'], ['default:water_source', 'Water'], ['default:stone', 'Stone'], ['default:dirt_with_snow', 'Snow'],
    ['default:cobble', 'Cobblestone (builds)'], ['default:wood', 'Wood (builds)']];
  return `<div class="leg">${legendCast.map((c) => `<span>${dot(c.dressColor || c.chatColor)}${esc(c.name)}</span>`).join('')}`
    + `<span>${dot('#ffffff')}Players</span><hr>${ground.map(([n, label]) => `<span>${sw(n)}${label}</span>`).join('')}</div>`;
}

// Live markers for both views: `at(x, y, z)` turns a block into the view's map position. Name tags only (owner:
// "just the name tag is fine"), and the iso view's toggles (characters, players, names) apply.
function markersScript() {
  return `const LEGEND = ${JSON.stringify(legendHtml())};
map.createPane('people').style.zIndex = 650; // over the map's chunks
const layer = L.layerGroup().addTo(map);
const shows = (k) => (typeof view === 'undefined' ? true : view[k]);
const where = async () => {
  try {
    const w = await (await fetch('/map/where.json', { cache: 'no-store' })).json();
    layer.clearLayers();
    const mark = (p, fill, r) => { const m = L.circleMarker(at(p.x, p.y, p.z), { pane: 'people', radius: r, color: '#141812', weight: 2, fillColor: fill, fillOpacity: 1 });
      // The name, and (a signpost, the owner liked it) what a character is building.
      if (shows('names')) m.bindTooltip(p.name + (p.doing && shows('doing') ? ' · ' + p.doing : ''), { permanent: true, direction: 'right', className: 'who', offset: [8, 0] });
      m.addTo(layer); };
    if (shows('characters')) for (const c of w.characters) mark(c, c.color, 8);
    if (shows('players')) for (const p of w.players) mark(p, '#ffffff', 6);
  } catch {}
};
where();
setInterval(where, 10000);
// The legend: who is who, and what the common colours are.
const Legend = L.Control.extend({ onAdd() {
  const el = L.DomUtil.create('div', 'legend');
  L.DomEvent.disableClickPropagation(el);
  el.innerHTML = '<details open><summary>Legend</summary>' + LEGEND + '</details>';
  return el;
} });
new Legend({ position: 'bottomright' }).addTo(map);`;
}
