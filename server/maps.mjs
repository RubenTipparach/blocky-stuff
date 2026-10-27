// Pictures of what the characters are up to (owner, 2026-10-27: "I just want screenshots or something of what these
// bots are up occasionally", "install map server, open to public view", "a server API to render stuff so the discord
// bot can post"). Isometric snapshots (server/map.mjs) of each character's project site, or of where she stands, kept
// on the volume and shown on a public page; renders on request; and posts to Discord every half hour while someone
// is in the game (owner, 2026-10-27: "post this only every once every 30 mins on the server IF theres anyone
// online"), and on !map.
//
//   GET /map                         the public page: a zoomable top-down map of the world (owner, 2026-10-27: "a google
//                                    style map on https://blocky-stuff.fly.dev/map") with the characters and players on
//                                    it, and the latest isometric picture of each character
//   GET /map/tiles/<x>/<y>.png       a 64 by 64 block tile of that map (x east, y south), drawn on first look, kept 30 min
//   GET /map/where.json              where the characters and players are now
//   GET /map/img/<name>.png          a kept picture
//   GET /map/render?x=&z=[&y=][&r=]  a fresh picture of any spot (r up to 48 blocks around), a few a minute per address

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderIso, renderTile } from './map.mjs';

const RADIUS = 32; // a snapshot covers 64 by 64 blocks
const EVERY_MS = 20 * 60_000; // a character's picture is refreshed this often while she is about
const RENDER_GAP_MS = 15_000; // one on-request render per address this often
const MAP_COMMAND_GAP_MS = 30_000; // !map at most this often
const TILE = 64; // blocks a side, per tile
const TILE_KEEP_MS = 30 * 60_000; // a drawn tile is good for this long
const TILE_AT_ONCE = 4; // tiles scanned at once, so the game never stalls on a map
// Every post ends with this (owner: "have the discord bot tell players to check out this site for more maps").
const MORE = (url) => `More maps: ${url}/map`;

export function createMaps({ db, game, config, characters, chat, now = () => Date.now(), log = console }) {
  const dir = join(config.dataDir, 'maps');
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
      y1: yy === null ? -20 : yy - 30, y2: yy === null ? 90 : yy + 50 });
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
        const r1 = await game.act({ type: 'scan', tops: true, x1: tx * TILE, z1, w: TILE, d: TILE, y1: -16, y2: 95 });
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
      res.end(page());
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

  function page() {
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
    const first = (game.bodies ?? [])[0] ?? { x: 0, z: 0 };
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blocky Stuff map</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin="">
<style>
:root { color-scheme: dark; --bg: #12150f; --panel: #1b2217; --line: #344030; --text: #f4f7ef; --muted: #a9b89a; --accent: #8fd16a; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 1200px; margin: 0 auto; padding: 20px 16px 40px; }
h1 { color: var(--accent); font-size: 24px; margin: 0 0 4px; } h2 { color: var(--accent); font-size: 18px; margin: 28px 0 10px; }
p { color: var(--muted); margin: 0 0 14px; } a { color: var(--accent); }
#map { height: min(72vh, 680px); border-radius: 10px; border: 1px solid var(--line); background: #a8c7d6; }
.leaflet-container { font: 13px system-ui, sans-serif; }
.who { background: rgba(20, 24, 18, .85); color: #fff; border: 0; border-radius: 6px; padding: 2px 6px; font-weight: 600; box-shadow: none; }
.who::before { display: none; }
.coords { background: rgba(20, 24, 18, .85); color: #fff; padding: 4px 8px; border-radius: 6px; font: 12px ui-monospace, monospace; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 520px), 1fr)); gap: 16px; }
figure { margin: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
figure img { display: block; width: 100%; height: auto; image-rendering: pixelated; }
figcaption { padding: 10px 12px; display: grid; gap: 2px; } figcaption span { color: var(--muted); font-size: 13px; }
code { background: #232a1f; padding: 1px 6px; border-radius: 4px; }
</style></head><body><main>
<h1>${esc(config.serverName)} map</h1>
<p>Drag and zoom the world; the characters and players move on it live. Join at
<code>${esc(config.gameAddress || new URL(config.publicUrl).hostname)}:${config.gamePort}</code> with <a href="https://www.luanti.org/en/">Luanti</a>.
Parts of the world nobody has been to yet stay blank.</p>
<div id="map"></div>
<h2>What the characters are up to</h2>
<p>Isometric pictures of each character, aimed at where she is, refreshed every 20 minutes.</p>
<div class="grid">${cards || '<p>No pictures yet: they come once a character is in the world.</p>'}</div></main>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>
<script>
// One map unit is one block: x east, and z north as the map's up (Leaflet's lat). Tiles are 64 blocks at zoom 2.
const map = L.map('map', { crs: L.CRS.Simple, minZoom: 0, maxZoom: 5, zoomSnap: 0.5, attributionControl: false })
  .setView([${Number(first.z) || 0}, ${Number(first.x) || 0}], 3);
L.tileLayer('/map/tiles/{x}/{y}.png', { tileSize: 256, minNativeZoom: 2, maxNativeZoom: 2, noWrap: true,
  errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }).addTo(map);
const layer = L.layerGroup().addTo(map);
const where = async () => {
  try {
    const w = await (await fetch('/map/where.json', { cache: 'no-store' })).json();
    layer.clearLayers();
    for (const c of w.characters) L.circleMarker([c.z, c.x], { radius: 8, color: '#141812', weight: 2, fillColor: c.color, fillOpacity: 1 })
      .bindTooltip(c.name + (c.doing ? ' · ' + c.doing : ''), { permanent: true, direction: 'right', className: 'who', offset: [8, 0] }).addTo(layer);
    for (const p of w.players) L.circleMarker([p.z, p.x], { radius: 6, color: '#141812', weight: 2, fillColor: '#ffffff', fillOpacity: 1 })
      .bindTooltip(p.name, { permanent: true, direction: 'right', className: 'who', offset: [8, 0] }).addTo(layer);
  } catch {}
};
where();
setInterval(where, 10000);
// The block under the pointer.
const Coords = L.Control.extend({ onAdd() { this.el = L.DomUtil.create('div', 'coords'); this.el.textContent = 'x, z'; return this.el; } });
const coords = new Coords({ position: 'bottomleft' }).addTo(map);
map.on('mousemove', (e) => { coords.el.textContent = 'x ' + Math.floor(e.latlng.lng) + ', z ' + Math.floor(e.latlng.lat); });
</script></body></html>`;
  }

  return { render, snapshot, tick, command, handle, settings, page, postNow, tile, where };
}
