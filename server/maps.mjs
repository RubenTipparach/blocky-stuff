// Pictures of what the characters are up to (owner, 2026-10-27: "I just want screenshots or something of what these
// bots are up occasionally", "install map server, open to public view", "a server API to render stuff so the discord
// bot can post"). Isometric snapshots (server/map.mjs) of each character's project site, or of where she stands, kept
// on the volume and shown on a public page; renders on request; and posts to Discord every half hour while someone
// is in the game (owner, 2026-10-27: "post this only every once every 30 mins on the server IF theres anyone
// online"), and on !map.
//
//   GET /map                         the public page: a zoomable isometric map of the world (owner, 2026-10-27: "a google
//                                    style map", "I wanted the isometric look on that map") with a depth slider, the
//                                    characters and players on it, and the latest picture of each character;
//                                    /map?view=flat is the same world flat, from above
//   GET /map/iso/<cx>/<cz>.png?top=  the 64 by 64 block chunk (cx, cz) drawn isometric in a fixed frame, cut at y = top,
//                                    with a clear background; chunks laid front over back make the map
//   GET /map/tiles/<x>/<y>.png       a 64 by 64 block tile of the flat map (x east, y south)
//   GET /map/where.json              where the characters and players are now
//   GET /map/explored.json           the 64-block chunks the world has anything in, and their bounds (owner: "isomap
//                                    should be bounded by explored areas ... so I cant just scroll infinitely")
//   GET /map/img/<name>.png          a kept picture
//   GET /map/render?x=&z=[&y=][&r=]  a fresh picture of any spot (r up to 48 blocks around), a few a minute per address

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { renderIso, renderTile } from './map.mjs';

const RADIUS = 32; // a snapshot covers 64 by 64 blocks
const EVERY_MS = 20 * 60_000; // a character's picture is refreshed this often while she is about
const RENDER_GAP_MS = 15_000; // one on-request render per address this often
const MAP_COMMAND_GAP_MS = 30_000; // !map at most this often
const TILE = 64; // blocks a side, per tile
const TILE_KEEP_MS = 30 * 60_000; // a drawn tile is good for this long
const TILE_AT_ONCE = 4; // tiles scanned at once, so the game never stalls on a map
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
    const rr = Math.max(8, Math.min(48, Math.round(r)));
    const yy = Number.isFinite(y) ? Math.round(y) : null;
    const r1 = await game.act({ type: 'scan', x1: Math.round(x) - rr, z1: Math.round(z) - rr, w: 2 * rr, d: 2 * rr,
      // Down to 48 blocks under her, whole columns to there (owner: "this should scan down to the lower depths").
      y1: yy === null ? -32 : yy - 48, y2: yy === null ? 120 : yy + 50 });
    if (!r1.ok) return { error: r1.message };
    let scan;
    try { scan = JSON.parse(r1.message); } catch { return { error: 'The game sent back something unreadable.' }; }
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
      await slot();
      try {
        // Rows of the tile run north to south: z from -ty*64 down to -ty*64-63. The scan runs z upward, so flip it.
        const z1 = -ty * TILE - (TILE - 1);
        const r1 = await game.act({ type: 'scan', tops: true, x1: tx * TILE, z1, w: TILE, d: TILE, y1: -32, y2: 127 });
        if (!r1.ok) return null;
        const scan = JSON.parse(r1.message);
        const rows = [];
        for (let z = TILE - 1; z >= 0; z--) rows.push(...(scan.cols ?? []).slice(z * TILE, z * TILE + TILE));
        const png = renderTile({ ...scan, cols: rows });
        await mkdir(join(dir, 'tiles'), { recursive: true });
        await writeFile(file, png);
        db.putJson('maps.tiles', { ...db.json('maps.tiles', {}), [key]: now() });
        return png;
      } finally {
        free();
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
      await slot();
      try {
        const r1 = await game.act({ type: 'scan', x1: cx * ISO.C, z1: cz * ISO.C, w: ISO.C, d: ISO.C, y1: ISO.YMIN, y2: cut });
        if (!r1.ok) return null;
        const png = renderIso(JSON.parse(r1.message), { scale: ISO.A, fixed: { ymin: ISO.YMIN, ymax: ISO.YMAX }, transparent: true }).png;
        await mkdir(join(dir, 'tiles'), { recursive: true });
        await writeFile(file, png);
        db.putJson('maps.tiles', { ...db.json('maps.tiles', {}), [key]: now() });
        return png;
      } finally {
        free();
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

  /** Where everyone is: characters (with their colours) and players online. */
  function where() {
    const byId = Object.fromEntries(characters().map((c) => [c.id, c]));
    return {
      characters: (game.bodies ?? []).filter((b) => byId[b.id]).map((b) => ({ name: byId[b.id].name, color: byId[b.id].dressColor,
        x: b.x, y: b.y, z: b.z, doing: byId[b.id].project?.title ?? null })),
      players: game.players.filter((p) => p.pos).map((p) => ({ name: p.name, x: p.pos.x, y: p.pos.y, z: p.pos.z })),
    };
  }

  /** !map, !map <name>, !map <x> <z> in the Discord channel. Returns true when the line was one. */
  async function command(text) {
    const m = /^!map(?:\s+(.+))?$/i.exec(String(text ?? '').trim());
    if (!m) return false;
    if (now() - lastMapCommand < MAP_COMMAND_GAP_MS) {
      await chat.post({ text: 'Give the map a moment: one !map every 30 seconds.' });
      return true;
    }
    lastMapCommand = now();
    const arg = (m[1] ?? '').trim();
    const xz = /^(-?\d+)[\s,]+(-?\d+)$/.exec(arg);
    if (xz) {
      const out = await render({ x: Number(xz[1]), z: Number(xz[2]) });
      if (out.error) await chat.post({ text: `No picture: ${out.error}` });
      else await chat.postImage?.({ png: out.png, filename: 'map.png', text: `Around ${xz[1]}, ${xz[2]}\n${MORE(config.publicUrl)}`, link: `${config.publicUrl}/map` });
      return true;
    }
    const all = characters();
    const pick = arg ? all.filter((c) => c.name.toLowerCase().startsWith(arg.toLowerCase())) : all;
    if (!pick.length) { await chat.post({ text: `Nobody called ${arg}. Try !map, !map <name> or !map <x> <z>.` }); return true; }
    for (const ch of pick.slice(0, 3)) {
      const snap = await snapshot(ch);
      if (snap) await postPicture(snap, snap.title, ch);
      else await chat.post({ text: `${ch.name} is not in the world right now.` });
    }
    return true;
  }

  /** The /map routes. Returns true when it answered. */
  async function handle(req, res, url, ip) {
    if (url.pathname === '/map' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page(url.searchParams.get('view') === 'flat' ? 'flat' : 'iso'));
      return true;
    }
    const t = /^\/map\/tiles\/(-?\d{1,4})\/(-?\d{1,4})\.png$/.exec(url.pathname);
    if (t && req.method === 'GET') {
      const png = game.connected ? await tile(Number(t[1]), Number(t[2])).catch(() => null) : null;
      if (!png) {
        res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '30' });
        res.end('The game is not answering; try again soon.');
        return true;
      }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=300' });
      res.end(png);
      return true;
    }
    const iso = /^\/map\/iso\/(-?\d{1,4})\/(-?\d{1,4})\.png$/.exec(url.pathname);
    if (iso && req.method === 'GET') {
      const top = Number(url.searchParams.get('top') ?? ISO.YMAX);
      const png = game.connected && Number.isFinite(top) ? await isoChunk(Number(iso[1]), Number(iso[2]), top).catch(() => null) : null;
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
        res.end('Give x and z: /map/render?x=10&z=-20 (optional y, and r up to 48).');
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

  function page(view = 'iso') {
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const byId = Object.fromEntries(characters().map((c) => [c.id, c]));
    const cards = Object.values(kept()).sort((x, y) => y.at - x.at).map((m) => {
      const c = byId[m.key];
      const mins = Math.max(0, Math.round((now() - m.at) / 60000));
      return `<figure><img src="/map/img/${esc(m.file)}?v=${m.at}" alt="${esc(m.title)}" loading="lazy">
        <figcaption><b style="color:${esc(c?.chatColor ?? '#8fd16a')}">${esc(c?.name ?? m.key)}</b> ${esc(m.title.split(': ').slice(1).join(': '))}
        <span>at ${m.x}, ${m.y}, ${m.z} · ${mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`}</span></figcaption></figure>`;
    }).join('');
    // Where to open the map: the first character, else 0, 0.
    const first = (game.bodies ?? [])[0] ?? { x: 0, y: 10, z: 0 };
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blocky Stuff map</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin="">
<style>
:root { color-scheme: dark; --bg: #12150f; --panel: #1b2217; --line: #344030; --text: #f4f7ef; --muted: #a9b89a; --accent: #8fd16a; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 1200px; margin: 0 auto; padding: 20px 16px 40px; }
h1 { color: var(--accent); font-size: 24px; margin: 0 0 4px; } h2 { color: var(--accent); font-size: 18px; margin: 28px 0 10px; }
p { color: var(--muted); margin: 0 0 14px; } a { color: var(--accent); }
#map { height: min(72vh, 680px); border-radius: 10px; border: 1px solid var(--line); background: #142038; }
.leaflet-container { font: 13px system-ui, sans-serif; }
.who { background: rgba(20, 24, 18, .85); color: #fff; border: 0; border-radius: 6px; padding: 2px 6px; font-weight: 600; box-shadow: none; }
.who::before { display: none; }
.cut { display: flex; gap: 12px; align-items: center; margin: 0 0 10px; color: var(--muted); }
.cut input { flex: 1 1 200px; max-width: 420px; accent-color: var(--accent); } .cut output { font: 600 14px ui-monospace, monospace; color: var(--text); min-width: 120px; }
.coords { background: rgba(20, 24, 18, .85); color: #fff; padding: 4px 8px; border-radius: 6px; font: 12px ui-monospace, monospace; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 520px), 1fr)); gap: 16px; }
figure { margin: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
figure img { display: block; width: 100%; height: auto; image-rendering: pixelated; }
figcaption { padding: 10px 12px; display: grid; gap: 2px; } figcaption span { color: var(--muted); font-size: 13px; }
code { background: #232a1f; padding: 1px 6px; border-radius: 4px; }
</style></head><body><main>
<h1>${esc(config.serverName)} map</h1>
<p>${view === 'iso' ? 'Drag and zoom the world, and slide the cut to look 10 blocks deeper at a time.' : 'Drag and zoom the world from above.'}
The characters and players move on it live. Join at
<code>${esc(config.gameAddress || new URL(config.publicUrl).hostname)}:${config.gamePort}</code> with <a href="https://www.luanti.org/en/">Luanti</a>.
Parts of the world nobody has been to yet stay blank. <a href="/map${view === 'iso' ? '?view=flat' : ''}">${view === 'iso' ? 'Top-down view' : 'Isometric view'}</a></p>
${view === 'iso' ? `<div class="cut"><label for="cut">Cut at height</label><input type="range" id="cut" min="${ISO.YMIN + 10}" max="${ISO.YMAX}" step="10" value="${ISO.YMAX}"><output id="cutOut">everything</output></div>` : ''}
<div id="map"></div>
<h2>What the characters are up to</h2>
<p>Isometric pictures of each character, aimed at where she is, refreshed every 20 minutes.</p>
<div class="grid">${cards || '<p>No pictures yet: they come once a character is in the world.</p>'}</div></main>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>
<script>
${view === 'iso' ? isoScript(first) : flatScript(first)}
</script></body></html>`;
  }

  return { render, snapshot, tick, command, handle, settings, page, postNow, tile, isoChunk, where };
}

// The flat map's script: one map unit is one block, x east and z north as the map's up; tiles are 64 blocks at zoom 2.
function flatScript(first) {
  return `const map = L.map('map', { crs: L.CRS.Simple, minZoom: 0, maxZoom: 5, zoomSnap: 0.5, attributionControl: false })
  .setView([${Number(first.z) || 0}, ${Number(first.x) || 0}], 3);
L.tileLayer('/map/tiles/{x}/{y}.png', { tileSize: 256, minNativeZoom: 2, maxNativeZoom: 2, noWrap: true,
  errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }).addTo(map);
const at = (x, y, z) => [z, x];
${markersScript()}
const Coords = L.Control.extend({ onAdd() { this.el = L.DomUtil.create('div', 'coords'); this.el.textContent = 'x, z'; return this.el; } });
const coords = new Coords({ position: 'bottomleft' }).addTo(map);
map.on('mousemove', (e) => { coords.el.textContent = 'x ' + Math.floor(e.latlng.lng) + ', z ' + Math.floor(e.latlng.lat); });`;
}

// The isometric map's script. One map unit is one pixel of the drawing at zoom 0; a block at (x, y, z) sits at
// GX = (x - z) * A, GY = (x + z) * A / 2 - y * A (as server/map.mjs draws it), and the map's up is -GY. Each chunk is an
// image in the shared frame, placed from ISO alone, the nearer (larger cx + cz) over the farther.
function isoScript(first) {
  const { A, YMIN, YMAX, C } = ISO;
  return `const A = ${A}, YMIN = ${YMIN}, YMAX = ${YMAX}, C = ${C};
const W = 2 * C * A + 2 * A, H = Math.round(C * A + (YMAX - YMIN + 3) * A + 3 * A), OX = C * A, OY = (YMAX - YMIN + 2) * A;
const gx = (x, z) => (x - z) * A, gy = (x, y, z) => (x + z) * A / 2 - y * A;
const at = (x, y, z) => [-(gy(x, y, z) + A / 2), gx(x, z) + A];
const map = L.map('map', { crs: L.CRS.Simple, minZoom: -4, maxZoom: 3, zoomSnap: 0.5, attributionControl: false,
  maxBoundsViscosity: 1 }).setView(at(${Number(first.x) || 0}, ${Number(first.y) || 10}, ${Number(first.z) || 0}), 0);
// Only the explored world: the chunks with anything saved, and no panning past their bounds.
let known = null;
fetch('/map/explored.json').then((r) => r.json()).then((e) => {
  if (!e.bounds) return;
  known = new Set(e.chunks.map(([cx, cz]) => cx + ',' + cz));
  const { cx1, cz1, cx2, cz2 } = e.bounds;
  const corners = [[cx1, cz1], [cx2, cz1], [cx1, cz2], [cx2, cz2]].map(([cx, cz]) => origin(cx, cz));
  const west = Math.min(...corners.map(([ox]) => ox)), east = Math.max(...corners.map(([ox]) => ox + W));
  const north = Math.min(...corners.map(([, oy]) => oy)), south = Math.max(...corners.map(([, oy]) => oy + H));
  const box = L.latLngBounds([[-north, west], [-south, east]]);
  map.setMaxBounds(box.pad(0.05));
  map.setMinZoom(Math.min(0, map.getBoundsZoom(box) - 0.5));
  load();
}).catch(() => {});
let cutAt = YMAX; // not "top": the browser already has a window.top
const shown = new Map();
const origin = (cx, cz) => { const x1 = cx * C, z1 = cz * C; return [(x1 - z1) * A - OX, (x1 + z1) * A / 2 - YMIN * A - OY]; };
function load() {
  const b = map.getBounds();
  const gx1 = b.getWest(), gx2 = b.getEast(), gy1 = -b.getNorth(), gy2 = -b.getSouth();
  const umin = gx1 / A - 2, umax = gx2 / A + 2, vmin = 2 * gy1 / A + 2 * YMIN - 4, vmax = 2 * gy2 / A + 2 * cutAt + 4;
  const want = [];
  for (let p = Math.floor((umin - C) / C); p <= Math.ceil((umax + C) / C); p++) {
    for (let q = Math.floor((vmin - 2 * C) / C); q <= Math.ceil(vmax / C); q++) {
      if ((p + q) % 2 !== 0) continue;
      const cx = (p + q) / 2, cz = (q - p) / 2;
      if (known && !known.has(cx + ',' + cz)) continue;
      const [ox, oy] = origin(cx, cz);
      if (ox > gx2 || ox + W < gx1 || oy > gy2 || oy + H < gy1) continue;
      want.push([cx, cz]);
    }
  }
  const mid = map.getCenter();
  want.sort((a, b) => { const [ax, ay] = origin(...a), [bx, by] = origin(...b);
    return Math.hypot(ax + W / 2 - mid.lng, -(ay + H / 2) - mid.lat) - Math.hypot(bx + W / 2 - mid.lng, -(by + H / 2) - mid.lat); });
  for (const [cx, cz] of want.slice(0, 60)) {
    const key = cx + ',' + cz + ',' + cutAt;
    if (shown.has(key)) continue;
    shown.set(key, null); // being fetched
    picture(cx, cz, cutAt).then((src) => {
      if (!src || !shown.has(key)) { shown.delete(key); return; }
      const [ox, oy] = origin(cx, cz);
      shown.set(key, L.imageOverlay(src, [[-oy, ox], [-(oy + H), ox + W]], { zIndex: 1000 + cx + cz, interactive: false }).addTo(map));
    });
  }
}
// Each chunk's picture is fetched once and kept in the page (owner: "cache these locally ... only fetch from server
// every 5 mins"): a chunk stays on the map once loaded, and is fetched again only when it is over 5 minutes old and in
// view. At most four fetches at a time.
const pictures = new Map(); // key -> { src, at }
const FRESH = 5 * 60 * 1000;
let fetching = 0;
const queue = [];
const turn = () => (fetching < 4 ? (fetching++, Promise.resolve()) : new Promise((r) => queue.push(r)));
const done = () => { fetching--; const next = queue.shift(); if (next) { fetching++; next(); } };
async function picture(cx, cz, top, again) {
  const key = cx + ',' + cz + ',' + top;
  const had = pictures.get(key);
  if (had && !again && Date.now() - had.at < FRESH) return had.src;
  await turn();
  try {
    const r = await fetch('/map/iso/' + cx + '/' + cz + '.png?top=' + top);
    if (!r.ok) return had ? had.src : null;
    const src = URL.createObjectURL(await r.blob());
    if (had) setTimeout(() => URL.revokeObjectURL(had.src), 2000);
    pictures.set(key, { src, at: Date.now() });
    return src;
  } catch { return had ? had.src : null; } finally { done(); }
}
// Every minute: chunks in view whose picture is over 5 minutes old are fetched again and swapped in place.
setInterval(() => {
  const b = map.getBounds();
  for (const [key, img] of shown) {
    if (!img || !b.intersects(img.getBounds())) continue;
    const [cx, cz, top] = key.split(',').map(Number);
    const had = pictures.get(key);
    if (had && Date.now() - had.at >= FRESH) picture(cx, cz, top, true).then((src) => { if (src && src !== had.src) img.setUrl(src); });
  }
}, 60 * 1000);
map.on('moveend', load);
load();
const cut = document.getElementById('cut'), cutOut = document.getElementById('cutOut');
let wait = null;
cut.addEventListener('input', () => {
  cutAt = Number(cut.value);
  cutOut.textContent = cutAt >= YMAX ? 'everything' : 'y ' + cutAt + ' and below';
  clearTimeout(wait);
  wait = setTimeout(() => { for (const img of shown.values()) if (img) map.removeLayer(img); shown.clear(); load(); }, 250);
});
${markersScript()}`;
}

// Live markers for both views: `at(x, y, z)` turns a block into the view's map position.
function markersScript() {
  return `map.createPane('people').style.zIndex = 650; // over the map's chunks
const layer = L.layerGroup().addTo(map);
const where = async () => {
  try {
    const w = await (await fetch('/map/where.json', { cache: 'no-store' })).json();
    layer.clearLayers();
    for (const c of w.characters) L.circleMarker(at(c.x, c.y, c.z), { pane: 'people', radius: 8, color: '#141812', weight: 2, fillColor: c.color, fillOpacity: 1 })
      .bindTooltip(c.name + (c.doing ? ' · ' + c.doing : ''), { permanent: true, direction: 'right', className: 'who', offset: [8, 0] }).addTo(layer);
    for (const p of w.players) L.circleMarker(at(p.x, p.y, p.z), { pane: 'people', radius: 6, color: '#141812', weight: 2, fillColor: '#ffffff', fillOpacity: 1 })
      .bindTooltip(p.name, { permanent: true, direction: 'right', className: 'who', offset: [8, 0] }).addTo(layer);
  } catch {}
};
where();
setInterval(where, 10000);`;
}
