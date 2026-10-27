// Pictures of what the characters are up to (owner, 2026-10-27: "I just want screenshots or something of what these
// bots are up occasionally", "install map server, open to public view", "a server API to render stuff so the discord
// bot can post"). Isometric snapshots (server/map.mjs) of each character's project site, or of where she stands, kept
// on the volume and shown on a public page; renders on request; and posts to Discord when a project is finished,
// every few hours while they work, and on !map.
//
//   GET /map                         the public page: the latest picture of each character, refreshed every 2 minutes
//   GET /map/img/<name>.png          a kept picture
//   GET /map/render?x=&z=[&y=][&r=]  a fresh picture of any spot (r up to 48 blocks around), a few a minute per address

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderIso } from './map.mjs';

const RADIUS = 32; // a snapshot covers 64 by 64 blocks
const EVERY_MS = 20 * 60_000; // a character's picture is refreshed this often while she is about
const RENDER_GAP_MS = 15_000; // one on-request render per address this often
const MAP_COMMAND_GAP_MS = 30_000; // !map at most this often

export function createMaps({ db, game, config, characters, chat, now = () => Date.now(), log = console }) {
  const dir = join(config.dataDir, 'maps');
  const lastAsk = new Map(); // address -> when it last rendered on request
  let lastMapCommand = 0;
  let busy = false;

  const kept = () => db.json('maps', {});
  const keep = (key, meta) => db.putJson('maps', { ...kept(), [key]: meta });
  const colorsByMark = () => Object.fromEntries(characters().map((c) => [c.id, c.dressColor || c.chatColor]));
  const settings = () => ({ every: 3, ...db.json('maps.settings', {}) });

  /** A picture of the area around (x, z): { png, scan } or { error }. y: about the ground there, if known. */
  async function render({ x, z, y = null, r = RADIUS }) {
    const rr = Math.max(8, Math.min(48, Math.round(r)));
    const yy = Number.isFinite(y) ? Math.round(y) : null;
    const r1 = await game.act({ type: 'scan', x1: Math.round(x) - rr, z1: Math.round(z) - rr, w: 2 * rr, d: 2 * rr,
      y1: yy === null ? -20 : yy - 30, y2: yy === null ? 90 : yy + 50 });
    if (!r1.ok) return { error: r1.message };
    let scan;
    try { scan = JSON.parse(r1.message); } catch { return { error: 'The game sent back something unreadable.' }; }
    return { png: renderIso(scan, { markColors: colorsByMark() }).png, scan };
  }

  /** Where a character is busy: her project's site, else her last finished one (for a day), else where she stands. */
  function spotOf(ch) {
    if (ch.project?.site) return { ...ch.project.site, what: `building ${ch.project.title} (${ch.project.done} of ${ch.project.steps.length} steps)` };
    if (ch.lastProject?.site && now() - ch.lastProject.at < 86_400_000) return { ...ch.lastProject.site, what: `finished ${ch.lastProject.title}` };
    const body = game.bodies?.find((b) => b.id === ch.id);
    return body ? { x: body.x, y: body.y, z: body.z, what: 'where she is now' } : null;
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
   * Every minute: refresh each character's picture when due, and post to Discord when she finished a project, or
   * every few hours (the setting) while she has been building.
   */
  async function tick() {
    if (busy || !game.connected) return;
    busy = true;
    try {
      const posted = db.json('maps.posted', {});
      const every = settings().every;
      for (const ch of characters()) {
        const was = kept()[ch.id];
        const finished = ch.lastProject && ch.lastProject.at > (posted[`${ch.id}:finished`] ?? 0);
        const due = !was || now() - was.at > EVERY_MS || finished || (ch.project && was.project !== ch.project.title);
        if (!due) continue;
        const snap = await snapshot(ch);
        if (!snap || !chat.mode) continue;
        if (finished) {
          posted[`${ch.id}:finished`] = now();
          await postPicture(snap, `${ch.name} finished ${ch.lastProject.title} at ${ch.lastProject.site.x}, ${ch.lastProject.site.y}, `
            + `${ch.lastProject.site.z}!`, ch);
        } else if (every > 0 && ch.project && now() - (posted[ch.id] ?? 0) > every * 3_600_000) {
          posted[ch.id] = now();
          await postPicture(snap, `${ch.name} is ${snap.title.split(': ')[1]}.`, ch);
        }
      }
      db.putJson('maps.posted', posted);
    } catch (err) {
      log.error('map tick failed:', err);
    } finally {
      busy = false;
    }
  }

  const postPicture = (snap, text, ch) => chat.postImage?.({ png: snap.png, filename: snap.file, text, as: ch?.name,
    color: ch?.chatColor, link: `${config.publicUrl}/map` });

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
      else await chat.postImage?.({ png: out.png, filename: 'map.png', text: `Around ${xz[1]}, ${xz[2]}`, link: `${config.publicUrl}/map` });
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
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const byId = Object.fromEntries(characters().map((c) => [c.id, c]));
    const cards = Object.values(kept()).sort((a, b) => b.at - a.at).map((m) => {
      const c = byId[m.key];
      const mins = Math.max(0, Math.round((now() - m.at) / 60000));
      return `<figure><img src="/map/img/${esc(m.file)}?v=${m.at}" alt="${esc(m.title)}" loading="lazy">
        <figcaption><b style="color:${esc(c?.chatColor ?? '#8fd16a')}">${esc(c?.name ?? m.key)}</b> ${esc(m.title.split(': ').slice(1).join(': '))}
        <span>at ${m.x}, ${m.y}, ${m.z} · ${mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`}</span></figcaption></figure>`;
    }).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="120"><title>Blocky Stuff map</title><style>
:root { color-scheme: dark; --bg: #12150f; --panel: #1b2217; --line: #344030; --text: #f4f7ef; --muted: #a9b89a; --accent: #8fd16a; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 1200px; margin: 0 auto; padding: 20px 16px 40px; }
h1 { color: var(--accent); font-size: 24px; margin: 0 0 4px; } p { color: var(--muted); margin: 0 0 18px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 520px), 1fr)); gap: 16px; }
figure { margin: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
figure img { display: block; width: 100%; height: auto; image-rendering: pixelated; background: #1b2217; }
figcaption { padding: 10px 12px; display: grid; gap: 2px; } figcaption span { color: var(--muted); font-size: 13px; }
code { background: #232a1f; padding: 1px 6px; border-radius: 4px; }
</style></head><body><main><h1>${esc(config.serverName)}: what the characters are up to</h1>
<p>Isometric pictures of each character's work, refreshed every 20 minutes. Join at <code>${esc(config.gameAddress || new URL(config.publicUrl).hostname)}:${config.gamePort}</code>
with <a href="https://www.luanti.org/en/" style="color:var(--accent)">Luanti</a>.</p>
<div class="grid">${cards || '<p>No pictures yet: they come once a character is in the world.</p>'}</div></main></body></html>`;
  }

  return { render, snapshot, tick, command, handle, settings, page };
}
