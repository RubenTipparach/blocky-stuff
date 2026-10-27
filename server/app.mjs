// The sidecar's HTTP server, after RubenTipparach/rubens-solitare-collection's server/app.mjs: plain node:http.
// It ties the pieces together: the game's bridge, the bot, Discord, the admin page and MCP.
//
//   GET  /health                        200 "ok" (Fly's check)
//   POST /bridge/sync                   the Lua mod, once a second (server/game.mjs); x-bridge-key, this machine only
//   POST /mcp                           MCP over Streamable HTTP (server/mcp.mjs); Bearer <MCP token>
//   GET  /admin                         the admin page (server/admin-page.mjs)
//   GET  /auth/discord/login?return=URL to Discord, for the admin page's sign-in
//   GET  /auth/discord/callback         from Discord; back to URL#blocky_token=<session>
//   GET  /api/info                      what is switched on, for setup
//   /api/admin...                       the admin page's calls, each checked against ADMIN_DISCORD_ID (below)

import { createServer } from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { sign, verify, nonce } from './tokens.mjs';
import { createGame } from './game.mjs';
import { createBot, botSettings } from './bot.mjs';
import { createDiscord } from './discord.mjs';
import { mcpAuthorized, mcpCall, storeMcpToken } from './mcp.mjs';
import { ADMIN_PAGE } from './admin-page.mjs';
import { TOOLS } from './tools.mjs';

const DISCORD = 'https://discord.com';
const BODY_MAX = 64 * 1024;
// The mod's sync carries every item name once, at start.
const SYNC_MAX = 2 * 1024 * 1024;
// An admin stays signed in this long.
const SESSION_DAYS = 30;
// Models the admin page offers; any other id may be typed in.
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * deps (each optional, for the tests): game, bot, discord, luanti (server/luanti.mjs), fetchImpl, now.
 * bridgeKey: the secret the mod sends, written into its config by server/luanti.mjs.
 */
export function makeApp({ config, db, bridgeKey, luanti = null, fetchImpl = fetch, now = () => Date.now(),
  game = createGame({ now }), discord = null, bot = null, log = console, daily = false }) {
  const sessionSecret = config.sessionSecret || db.secret('session');
  const redirectUri = `${config.publicUrl}/auth/discord/callback`;
  const relay = () => ({ chat: true, news: true, ...db.json('relay', {}) });
  const botName = () => botSettings(db, config).name;
  const joinAt = () => `${config.gameAddress || new URL(config.publicUrl).hostname}:${config.gamePort}`;

  const chat = discord ?? createDiscord({
    token: config.discordBotToken, webhookUrls: config.discordWebhookUrls, fetchImpl, log, botName,
    // DISCORD_CHANNEL_ID wins; otherwise the channels last picked on /admin.
    channelIds: config.discordChannelIds.length ? config.discordChannelIds : (db.setting('discord.channels') ?? '').split(',')
      .filter(Boolean),
    onMessage: (m) => fromDiscord(m),
  });
  const brain = bot ?? createBot({ db, game, config, now, log });

  // ---- Chat, between the game, Discord and the bot ----

  /** The bot's answer: into the game, the log, and Discord (always, when the question came from there). */
  async function botSays(text, { toDiscord = false, near } = {}) {
    const name = botName();
    db.addChat('bot', name, text, now());
    // near: the player it answers, whom its body in the world walks over to.
    const [r] = await Promise.all([game.act({ type: 'say', text, from: name, ...(near ? { near } : {}) }),
      relay().chat || toDiscord ? chat.post({ text, as: name }) : null]);
    return r;
  }
  /** An admin's or the server's announcement: the same, under the server's name. */
  async function announce(text) {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!t) return { ok: false, message: 'Nothing to say.' };
    db.addChat('admin', 'Server', t, now());
    const [r] = await Promise.all([game.act({ type: 'say', text: t, from: 'Server' }),
      relay().chat ? chat.post({ text: t, as: 'Server' }) : null]);
    return r;
  }

  // When a player or Discord last said anything, or the bot last spoke: the idle clock counts from here.
  let lastActivity = now();
  game.onEvent((e) => {
    if (e.type === 'chat' || e.type === 'join') lastActivity = now();
    if (e.type === 'chat' && typeof e.name === 'string' && typeof e.text === 'string') {
      db.addChat('game', e.name, e.text, now());
      if (relay().chat) chat.post({ text: e.text, as: e.name });
      const admin = game.player(e.name)?.privs.includes('server') ?? false;
      brain.hear({ source: 'game', name: e.name, text: e.text, admin }, (t) => botSays(t, { near: e.name }))
        .catch((err) => log.error(err));
    } else if (e.type === 'join' || e.type === 'leave') {
      const line = `${e.name} ${e.type === 'join' ? 'joined' : 'left'} the game`;
      db.addChat('game', '*', line, now());
      if (relay().news) chat.news(e.type, `**${e.name}** ${e.type === 'join' ? 'joined' : 'left'} the game.`);
      // Listening to everything, the bot may greet whoever arrives.
      if (e.type === 'join' && botSettings(db, config).listen === 'all') {
        setTimeout(() => brain.hear({ source: 'game', name: e.name, text: '(just joined the game)', admin: false },
          (t) => botSays(t, { near: e.name })).catch((err) => log.error(err)), 3000);
      }
    } else if (e.type === 'start') {
      db.addChat('game', '*', 'The server started', now());
      if (relay().news) chat.news('up', `**${config.serverName}** is up. Join at \`${joinAt()}\`.`);
    }
  });

  // The idle clock: a quiet minute (the bot's idle `after`) with a player online, and the bot takes a turn.
  let idling = false;
  async function idleTick() {
    const s = botSettings(db, config);
    if (idling || !s.idle.enabled || !game.players.length || now() - lastActivity < s.idle.after * 1000) return;
    idling = true;
    try {
      await brain.idle?.((t) => botSays(t));
    } finally {
      lastActivity = now();
      idling = false;
    }
  }
  if (daily) setInterval(() => { idleTick().catch((err) => log.error('idle turn failed:', err)); }, 5000).unref();

  function fromDiscord(m) {
    lastActivity = now();
    db.addChat('discord', m.name, m.text, now());
    if (relay().chat) game.act({ type: 'say', text: m.text, from: `[Discord] ${m.name}` });
    // An admin on Discord is known by their Discord id, which Discord vouches for; a name anyone can type.
    const admin = Boolean(m.userId) && config.adminIds.includes(m.userId);
    brain.hear({ source: 'discord', name: m.name, text: m.text, admin }, (t) => botSays(t, { toDiscord: true }))
      .catch((err) => log.error(err));
  }

  // ---- The daily summary: once a day at the bot's summary hour (UTC), to Discord and the game ----

  async function dailySummary({ force = false } = {}) {
    const s = botSettings(db, config);
    const t = new Date(now());
    const day = t.toISOString().slice(0, 10);
    if (!force && (s.summaryHour < 0 || t.getUTCHours() < s.summaryHour || db.setting('summary.last') === day)) return null;
    db.putSetting('summary.last', day);
    const text = await brain.summary(now() - 24 * 3600_000);
    if (!text) return null;
    db.addChat('bot', s.name, text, now());
    await Promise.all([chat.post({ text: `📋 Daily summary: ${text}`, as: s.name }),
      game.act({ type: 'say', text: `Daily summary: ${text}`, from: s.name })]);
    return text;
  }
  if (daily) setInterval(() => { dailySummary().catch((err) => log.error('daily summary failed:', err)); }, 10 * 60_000).unref();

  // ---- Plumbing ----

  const hits = new Map();
  const limited = (ip) => {
    const t = now();
    const h = hits.get(ip) ?? { n: 0, since: t };
    if (t - h.since > 10_000) { h.n = 0; h.since = t; }
    h.n++;
    hits.set(ip, h);
    if (hits.size > 10_000) hits.clear();
    return h.n > 60;
  };
  const send = (res, status, body, headers = {}) => {
    const json = typeof body !== 'string';
    res.writeHead(status, { 'content-type': json ? 'application/json' : 'text/plain; charset=utf-8', ...headers });
    res.end(json ? JSON.stringify(body) : body);
  };
  const redirect = (res, location) => { res.writeHead(302, { location, 'cache-control': 'no-store' }); res.end(); };
  const readBody = (req, max = BODY_MAX) => new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size <= max) chunks.push(c); });
    req.on('end', () => {
      if (size > max) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
    });
  });
  const session = (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const p = m ? verify(m[1], sessionSecret, now()) : null;
    return p?.kind === 'session' ? p : null;
  };
  const sameKey = (a, b) => {
    const x = Buffer.from(String(a ?? ''));
    const y = Buffer.from(String(b ?? ''));
    return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
  };
  // The mod calls from this machine: loopback, or the address Luanti is bound to (server/luanti.mjs).
  const fromHere = (req) => {
    const ip = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    return ip === '127.0.0.1' || ip === '::1' || (luanti !== null && ip === luanti.status().bindAddress);
  };

  function status() {
    const s = botSettings(db, config);
    return {
      server: { name: config.serverName, address: joinAt(),
        connected: game.connected, seenAt: game.seenAt || null, items: game.items.length,
        timeOfDay: game.time === null ? null : Math.round(game.time * 240) / 10, process: luanti?.status() ?? null },
      players: game.players,
      bot: { ready: brain.ready, name: s.name, model: s.model, enabled: s.enabled },
      discord: { mode: chat.mode, problem: chat.problem, listening: chat.listening, channelIds: chat.channelIds,
        hasBot: chat.hasBot, invite: inviteUrl() },
    };
  }

  // The link that adds the bot to a Discord server: View Channels, Send Messages, Embed Links and Read Message
  // History, nothing more. The bot is the same Discord application as the sign-in.
  const inviteUrl = () => (config.discordClientId
    ? `${DISCORD}/oauth2/authorize?client_id=${encodeURIComponent(config.discordClientId)}&scope=bot&permissions=84992` : null);

  // ---- Discord sign-in (the admin page) ----

  const ownPage = (url) => { try { return new URL(url).origin === new URL(config.publicUrl).origin; } catch { return false; } };

  function login(req, res, url) {
    const back = url.searchParams.get('return') || `${config.publicUrl}/admin`;
    if (!ownPage(back)) return send(res, 400, 'That return address is not this server.');
    if (config.missing.signIn.length) {
      return send(res, 503, `Sign-in is not set up yet (missing ${config.missing.signIn.join(', ')}).`);
    }
    const state = sign({ kind: 'state', back, n: nonce(), exp: Math.floor(now() / 1000) + 600 }, sessionSecret);
    const q = new URLSearchParams({ client_id: config.discordClientId, redirect_uri: redirectUri, response_type: 'code',
      scope: 'identify', state, prompt: 'none' });
    redirect(res, `${DISCORD}/oauth2/authorize?${q}`);
  }

  async function callback(req, res, url) {
    const state = verify(url.searchParams.get('state') ?? '', sessionSecret, now());
    const back = new URL(state?.kind === 'state' && ownPage(state.back) ? state.back : `${config.publicUrl}/admin`);
    const fail = (why) => { back.hash = `blocky_error=${encodeURIComponent(why)}`; redirect(res, back.toString()); };
    if (state?.kind !== 'state') return fail('That sign-in did not go through: try again.');
    if (url.searchParams.get('error')) return fail('Sign-in was canceled.');
    const code = url.searchParams.get('code');
    if (!code) return fail('Discord sent no code.');
    try {
      const tokenRes = await fetchImpl(`${DISCORD}/api/oauth2/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri,
          client_id: config.discordClientId, client_secret: config.discordClientSecret }),
      });
      if (!tokenRes.ok) return fail('Discord refused the sign-in.');
      const { access_token: accessToken } = await tokenRes.json();
      const meRes = await fetchImpl(`${DISCORD}/api/users/@me`, { headers: { authorization: `Bearer ${accessToken}` } });
      if (!meRes.ok) return fail('Discord did not say who you are.');
      const u = await meRes.json();
      const token = sign({
        kind: 'session', sub: String(u.id), name: String(u.global_name || u.username || 'Admin').slice(0, 40),
        avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : null,
        exp: Math.floor(now() / 1000) + SESSION_DAYS * 86400,
      }, sessionSecret);
      back.hash = `blocky_token=${token}`;
      redirect(res, back.toString());
    } catch {
      fail('Could not reach Discord.');
    }
  }

  // ---- The admin API ----

  // The signed-in admin, or null with the answer already sent (401 signed out, 403 not an admin).
  function adminOf(req, res) {
    const s = session(req);
    if (!s) { send(res, 401, { error: 'Not signed in.' }); return null; }
    if (!config.adminIds.includes(s.sub)) {
      send(res, 403, { error: 'Not an admin.', you: { id: s.sub, name: s.name } });
      return null;
    }
    return { id: s.sub, name: s.name, avatar: s.avatar };
  }

  async function admin(req, res, route) {
    const you = adminOf(req, res);
    if (!you) return undefined;
    if (route === 'GET /api/admin') {
      return send(res, 200, {
        you, ...status(), settings: botSettings(db, config), relay: relay(), models: MODELS, efforts: EFFORTS,
        policyTools: TOOLS.filter((t) => t.permission && t.permission !== 'admin').map((t) => ({ name: t.name, permission: t.permission })),
        missing: config.missing, chat: db.chat(80), usage: db.usage(14),
        mcp: { url: `${config.publicUrl}/mcp`, hasToken: Boolean(config.mcpToken || db.setting('mcp.token')) },
        log: luanti?.log(80) ?? [],
      });
    }
    const body = req.method === 'POST' ? (await readBody(req)) ?? {} : {};
    if (route === 'POST /api/admin/bot') {
      const cur = db.json('bot', {});
      const next = { ...cur };
      if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
      if (typeof body.name === 'string' && /^[\w-]{2,20}$/.test(body.name.trim())) next.name = body.name.trim();
      if (typeof body.model === 'string' && /^[a-z0-9.-]{3,60}$/.test(body.model)) next.model = body.model;
      if (EFFORTS.includes(body.effort)) next.effort = body.effort;
      if (typeof body.persona === 'string') next.persona = body.persona.slice(0, 2000);
      for (const k of ['cooldown', 'perHour', 'perDay']) {
        if (Number.isFinite(Number(body[k])) && Number(body[k]) >= 0) next[k] = Math.floor(Number(body[k]));
      }
      if (body.listen === 'all' || body.listen === 'mentions') next.listen = body.listen;
      if (body.idle && typeof body.idle === 'object') {
        const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.floor(Number(v)))) : d);
        next.idle = { enabled: body.idle.enabled !== false, after: num(body.idle.after, 15, 3600, 60),
          perHour: num(body.idle.perHour, 0, 120, 20) };
      }
      if (Number.isInteger(Number(body.summaryHour)) && Number(body.summaryHour) >= -1 && Number(body.summaryHour) <= 23) {
        next.summaryHour = Number(body.summaryHour);
      }
      if (body.policy && typeof body.policy === 'object') {
        next.policy = Object.fromEntries(Object.entries(body.policy).filter(([, v]) => typeof v === 'boolean'));
      }
      db.putJson('bot', next);
      return send(res, 200, { settings: botSettings(db, config) });
    }
    if (route === 'POST /api/admin/relay') {
      db.putJson('relay', { chat: body.chat !== false, news: body.news !== false });
      return send(res, 200, { relay: relay() });
    }
    if (route === 'POST /api/admin/announce') return send(res, 200, await announce(body.text));
    // The players table's buttons: one action, as server/game.mjs takes it.
    if (route === 'POST /api/admin/action') {
      if (!['kick', 'teleport', 'heal', 'give', 'time'].includes(body.type)) return send(res, 400, { error: 'Not an admin action.' });
      return send(res, 200, await game.act(body));
    }
    if (route === 'POST /api/admin/restart') {
      if (!luanti) return send(res, 400, { error: 'This server does not run Luanti itself (LUANTI_MANAGED=false).' });
      luanti.restart().catch((err) => log.error('restart failed:', err));
      return send(res, 200, { ok: true });
    }
    if (route === 'GET /api/admin/channels') {
      try { return send(res, 200, { channels: await chat.channels() }); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (route === 'POST /api/admin/channels') {
      const ids = Array.isArray(body.ids) ? body.ids : [];
      if (!chat.setChannels(ids)) return send(res, 400, { error: 'Those are not channel ids.' });
      db.putSetting('discord.channels', chat.channelIds.join(','));
      return send(res, 200, { channelIds: chat.channelIds });
    }
    if (route === 'POST /api/admin/discord-test') {
      if (!chat.mode) return send(res, 400, { error: chat.problem });
      return send(res, 200, await chat.news('bot', `Radio check from the admin page, by ${you.name}. This channel is wired up.`));
    }
    if (route === 'POST /api/admin/summary') {
      const text = await dailySummary({ force: true });
      return send(res, text ? 200 : 400, text ? { ok: true, text } : { error: 'Nothing happened in the last day, or the bot is off.' });
    }
    if (route === 'POST /api/admin/mcp-token') {
      const token = `blk_${randomBytes(24).toString('base64url')}`;
      storeMcpToken(db, token);
      return send(res, 200, { token, url: `${config.publicUrl}/mcp` });
    }
    return send(res, 404, { error: 'Not found.' });
  }

  // ---- Routes ----

  async function handle(req, res) {
    const url = new URL(req.url, config.publicUrl);
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /health') return send(res, 200, 'ok');

    if (route === 'POST /bridge/sync') {
      if (!sameKey(req.headers['x-bridge-key'], bridgeKey) || (config.luantiManaged && !fromHere(req))) {
        return send(res, 403, { error: 'Not the game.' });
      }
      const body = await readBody(req, SYNC_MAX);
      if (!body) return send(res, 400, { error: 'Not JSON.' });
      return send(res, 200, { ...game.sync(body), bot: botName() });
    }

    const ip = req.headers['fly-client-ip'] ?? req.socket.remoteAddress ?? '';
    if (/^\/(api|auth|mcp)/.test(url.pathname) && limited(ip)) return send(res, 429, 'Slow down.');

    if (url.pathname === '/mcp') {
      if (!mcpAuthorized(req, { config, db })) {
        return send(res, 401, { error: 'Send Authorization: Bearer <token>; make one on /admin.' },
          { 'www-authenticate': 'Bearer' });
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'POST JSON-RPC here.' }, { allow: 'POST' });
      const msg = await readBody(req);
      if (!msg) return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Not JSON.' } });
      const ctx = { game, db, status, announce };
      if (Array.isArray(msg)) {
        const out = (await Promise.all(msg.map((m) => mcpCall(m, ctx)))).filter(Boolean);
        return out.length ? send(res, 200, out) : (res.writeHead(202), res.end());
      }
      const out = await mcpCall(msg, ctx);
      if (!out) { res.writeHead(202); return res.end(); }
      return send(res, 200, out);
    }

    if (route === 'GET /' || route === 'GET /admin') {
      if (route === 'GET /') return redirect(res, '/admin');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(ADMIN_PAGE);
    }
    if (url.pathname.startsWith('/api/admin')) return admin(req, res, route);
    if (route === 'GET /auth/discord/login') return login(req, res, url);
    if (route === 'GET /auth/discord/callback') return callback(req, res, url);
    if (route === 'GET /api/info') {
      return send(res, 200, { game: game.connected, players: game.players.length, bot: brain.ready, discord: chat.mode,
        signIn: !config.missing.signIn.length, missing: config.missing });
    }
    return send(res, 404, { error: 'Not found.' });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error('request failed:', err);
      if (!res.headersSent) send(res, 500, { error: 'Server error.' });
    });
  });
  server.game = game;
  server.discord = chat;
  server.announce = announce;
  server.dailySummary = dailySummary;
  server.idleTick = idleTick;
  return server;
}
