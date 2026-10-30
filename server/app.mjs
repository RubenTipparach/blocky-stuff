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
import { createDiscord, codeCoords } from './discord.mjs';
import { mcpAuthorized, mcpCall, storeMcpToken } from './mcp.mjs';
import { ADMIN_PAGE } from './admin-page.mjs';
import { createMaps } from './maps.mjs';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS } from './tools.mjs';
import { cast as castOf, activeCast, saveCharacter, removeCharacter, personId, characterPersonId, affinityWord,
  trustWord, needsOf, traitsOf } from './character.mjs';

// A /link code lasts this long.
const LINK_MS = 10 * 60_000;
// Where new players get the game, in the "server is up" post.
const LUANTI_URL = 'https://www.luanti.org/en/';

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

  /** Change the bot's settings (from /admin or MCP); only what `body` names, checked. Returns them all. */
  function saveBotSettings(body) {
    const cur = db.json('bot', {});
    const next = { ...cur };
    if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
    if (typeof body.name === 'string' && /^[\w-]{2,20}$/.test(body.name.trim())) next.name = body.name.trim();
    if (typeof body.model === 'string' && /^[a-z0-9.-]{3,60}$/.test(body.model)) next.model = body.model;
    if (typeof body.buildModel === 'string' && /^[a-z0-9.-]{3,60}$/.test(body.buildModel)) next.buildModel = body.buildModel;
    if (EFFORTS.includes(body.effort)) next.effort = body.effort;
    if (typeof body.persona === 'string') next.persona = body.persona.slice(0, 2000);
    // Tool rounds one task may take in all (owner, 2026-10-27: "Bot complains it takes too long").
    if (Number.isFinite(Number(body.taskRounds)) && Number(body.taskRounds) >= 10) next.taskRounds = Math.min(1000, Math.floor(Number(body.taskRounds)));
    for (const k of ['cooldown', 'perHour', 'perDay']) {
      if (Number.isFinite(Number(body[k])) && Number(body[k]) >= 0) next[k] = Math.floor(Number(body[k]));
    }
    if (['all', 'every', 'mentions'].includes(body.listen)) next.listen = body.listen;
    if (Number.isFinite(Number(body.sleepAfter))) next.sleepAfter = Math.min(720, Math.max(5, Math.round(Number(body.sleepAfter))));
    if (typeof body.sleep === 'boolean') {
      // Switched off: wake them now (owner: "If I toggle sleep off wake bots up immediately"): the next sync stands
      // their bodies up, and an own turn starts at once instead of at the next tick.
      if (!body.sleep && botSettings(db, config).sleep) setTimeout(() => { idleTick().catch((err) => log.error(err)); }, 100);
      next.sleep = body.sleep;
    }
    if (typeof body.romance === 'boolean') next.romance = body.romance;
    if (typeof body.pranks === 'boolean') next.pranks = body.pranks;
    if (body.idle && typeof body.idle === 'object') {
      const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.floor(Number(v)))) : d);
      const was = botSettings(db, config).idle; // a partial change keeps the rest
      next.idle = { enabled: typeof body.idle.enabled === 'boolean' ? body.idle.enabled : was.enabled, after: num(body.idle.after, 15, 3600, was.after),
        perHour: num(body.idle.perHour, 0, 120, was.perHour), social: num(body.idle.social, 0, 100, was.social),
        kindness: num(body.idle.kindness, 0, 100, was.kindness) };
    }
    if (Number.isInteger(Number(body.summaryHour)) && Number(body.summaryHour) >= -1 && Number(body.summaryHour) <= 23) {
      next.summaryHour = Number(body.summaryHour);
    }
    if (body.policy && typeof body.policy === 'object') {
      next.policy = Object.fromEntries(Object.entries(body.policy).filter(([, v]) => typeof v === 'boolean'));
    }
    db.putJson('bot', next);
    return botSettings(db, config);
  }

  // The Activity feed's filters, as kinds of event.
  const FEED_KINDS = { talk: ['answered', 'quiet', 'chat'], work: ['own turn', 'task', 'prank', 'kindness'], skipped: ['skipped', 'ignored'], problems: ['limited', 'error'] };
  // Once: "mentions only" was the first version's default and stayed saved; everyone gets an answer now (owner,
  // 2026-10-27: "Someone should reply"). Set it back on /admin after this if wanted.
  if (!db.setting('once.listen-all')) {
    const b = db.json('bot', {});
    if (b.listen === 'mentions') db.putJson('bot', { ...b, listen: 'all' });
    db.putSetting('once.listen-all', '1');
  }
  // Once: the first pace (a turn after a minute, 30 an hour) was too chatty (owner, 2026-10-27: "Bots are too chatty.
  // They should say or do something after about 5-10 mins of idle time"): at least 5 minutes, at most 12 an hour.
  if (!db.setting('once.idle-pace')) {
    const b = db.json('bot', {});
    if (b.idle) db.putJson('bot', { ...b, idle: { ...b.idle, after: Math.max(300, b.idle.after ?? 300), perHour: Math.min(12, b.idle.perHour ?? 12) } });
    db.putSetting('once.idle-pace', '1');
  }
  const redirectUri = `${config.publicUrl}/auth/discord/callback`;
  const relay = () => ({ chat: true, news: true, ...db.json('relay', {}) });
  // The characters in the world now, and the one who speaks for the server (the first).
  const characters = () => activeCast(db, config, now());
  const host = () => characters()[0] ?? { id: 'blocky', name: 'Blocky', chatColor: '#f2b84b' };
  // What the game needs of each character for its body and its name in chat.
  const bodies = () => characters().map((c) => ({ id: c.id, name: c.name, chat: c.chatColor, dress: c.dressColor, hair: c.hairColor,
    asleep: asleep() }));
  // How each character feels about each player online, for the meter a player sees when looking at one.
  const meters = () => Object.fromEntries(game.players.map((p) => [p.name, Object.fromEntries(characters().map((c) => {
    const b = db.bond(c.id, personId('game', p.name));
    return [c.id, { a: b.affinity, t: b.trust, w: affinityWord(b.affinity), tw: trustWord(b.trust) }];
  }))]));
  const joinAt = () => `${config.gameAddress || new URL(config.publicUrl).hostname}:${config.gamePort}`;

  const chat = discord ?? createDiscord({
    token: config.discordBotToken, webhookUrls: config.discordWebhookUrls, fetchImpl, log, botName: () => host().name,
    // DISCORD_CHANNEL_ID wins; otherwise the channels last picked on /admin.
    channelIds: config.discordChannelIds.length ? config.discordChannelIds : (db.setting('discord.channels') ?? '').split(',')
      .filter(Boolean),
    onMessage: (m) => fromDiscord(m),
    lastSeen: { get: (ch) => db.setting(`discord.seen.${ch}`), set: (ch, id) => db.putSetting(`discord.seen.${ch}`, id) },
    onCommand: (c) => { slash(c).catch((err) => log.error(`/${c.name} failed:`, err)); },
  });
  const brain = bot ?? createBot({ db, game, config, now, log, asleep: () => asleep() });
  const maps = createMaps({ db, game, config, characters: () => characters(), chat, now, log });
  if (daily) setInterval(() => { maps.tick().catch((err) => log.error('map tick failed:', err)); }, 60_000).unref();

  // ---- Chat, between the game, Discord and the bot ----

  /**
   * A character's line: into the game (in its colour, its body walking to `near`), the log, and Discord (always,
   * when the question came from there). Characters it names may answer it, a few in a row at most.
   */
  async function botSays(text, ch = host(), { toDiscord = false, near, depth = 0 } = {}) {
    db.addChat('bot', ch.name, text, now());
    db.meet(characterPersonId(ch.id), ch.name, { at: now() });
    const [r] = await Promise.all([game.act({ type: 'say', text, from: ch.name, by: ch.id, color: ch.chatColor,
      ...(near ? { near } : {}) }), relay().chat || toDiscord ? chat.post({ text, as: ch.name, color: ch.chatColor }) : null]);
    for (const other of brain.answerers?.(text, ch, depth) ?? []) {
      brain.hear({ source: 'character', name: ch.name, text, personId: characterPersonId(ch.id), only: other.id, depth: depth + 1 },
        (t, who) => botSays(t, who, { toDiscord, depth: depth + 1 })).catch((err) => log.error(err));
    }
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

  // When a person last did anything (chat in game or on Discord, joined, gave an order): the characters keep working
  // on their own while a player is online, and for WORK_AFTER_MS after the last of this.
  // Kept in the database, so a bot restart does not count as someone being around.
  let lastActivity = Number(db.setting('activity.last')) || now();
  // Put to sleep by hand (admin page or MCP): they stay asleep until a player next says something or joins
  // (owner, 2026-10-29: "Is there a way to put them to sleep manually").
  let napping = db.setting('sleep.now') === '1';
  const sleepNow = (on) => { napping = Boolean(on); db.putSetting('sleep.now', napping ? '1' : '0'); return { asleep: asleep() }; };
  const active = () => {
    lastActivity = now(); db.putSetting('activity.last', String(lastActivity));
    if (napping) sleepNow(false);
  };
  // The game's items come once, when Luanti starts; a bot restarted on its own (a hot update) gets them back from here.
  // Without this, find_items found nothing after every hot update, and the characters believed there were no doors,
  // seeds or hoes (owner, 2026-10-27: "Bot says no door", "Need to give bots all items").
  if (!game.items.length) game.items = db.json('game.items', []);
  game.onEvent((e) => {
    if (e.type === 'start' && Array.isArray(e.items) && e.items.length) db.putJson('game.items', e.items);
    if (e.type === 'chat' || e.type === 'join' || e.type === 'order') active();
    if (e.type === 'chat' && typeof e.name === 'string' && typeof e.text === 'string') {
      // Everyone who chats is someone the bot knows, whether or not it answers.
      db.meet(personId('game', e.name), e.name, { at: now() });
      db.addChat('game', e.name, e.text, now());
      if (relay().chat) chat.post({ text: e.text, as: e.name, color: db.colorOf(personId('game', e.name)) });
      const admin = game.player(e.name)?.privs.includes('server') ?? false;
      // target: the character they were looking at, or stood next to, when they said it (the mod works it out).
      brain.hear({ source: 'game', name: e.name, text: e.text, admin, personId: personId('game', e.name),
        target: typeof e.target === 'string' ? e.target : undefined },
        (t, ch) => botSays(t, ch, { near: e.name }))
        .catch((err) => log.error(err));
    } else if (e.type === 'linkcode' && typeof e.name === 'string') {
      db.meet(personId('game', e.name), e.name, { at: now(), talked: false });
      linkCode(e.name);
    } else if (e.type === 'order' && typeof e.name === 'string' && typeof e.target === 'string') {
      // /follow, /come, /stay: done in game at once; the character remembers being asked.
      db.meet(personId('game', e.name), e.name, { at: now() });
      const ch = characters().find((c) => c.id === e.target);
      if (ch) db.addChat('game', '*', `${e.name} asked ${ch.name} to ${e.order === 'stay' ? 'stay put' : e.order === 'come' ? 'come over' : 'follow them'}`, now());
    } else if (e.type === 'join' || e.type === 'leave') {
      db.meet(personId('game', e.name), e.name, { at: now(), talked: false });
      const line = `${e.name} ${e.type === 'join' ? 'joined' : 'left'} the game`;
      db.addChat('game', '*', line, now());
      if (relay().news) chat.news(e.type, `**${e.name}** ${e.type === 'join' ? 'joined' : 'left'} the game.`);
      // Listening to everything, the bot may greet whoever arrives.
      if (e.type === 'join' && botSettings(db, config).listen !== 'mentions') {
        setTimeout(() => brain.hear({ source: 'game', name: e.name, text: '(just joined the game)', admin: false, event: true,
          personId: personId('game', e.name) },
          (t, ch) => botSays(t, ch, { near: e.name })).catch((err) => log.error(err)), 3000);
      }
    } else if (e.type === 'start') {
      db.addChat('game', '*', 'The server started', now());
      if (relay().news) {
        chat.news('up', `**${config.serverName}** is up. Join at \`${joinAt()}\`. `
          + `New here? Get Luanti free at ${LUANTI_URL}, then Join Game with that address.`);
      }
    }
  });

  // The work clock: while a player is online, or within WORK_AFTER_MS of anyone's last word, the characters take
  // turns of their own (server/bot.mjs idle: their projects), one at a time, each when she has not been asked
  // anything for the idle spell (owner, 2026-10-27: "if they are on their own they should build whatever they want,
  // at least for an hour or so").
  let idling = false;
  /** Asleep: the sleep setting is on and nobody is in the game. */
  // Asleep: nobody in the game, and no player has said anything (in the game or on Discord) for the sleep delay
  // (owner, 2026-10-27: "a slider for how much time without player or discord chat activity to sleep. Default is 1 hour").
  // A player whose place and gaze have not changed for the sleep delay is away from the keyboard, and does not keep
  // them awake (owner, 2026-10-29: "bots are still active", with a phone left connected in the background).
  const stirred = new Map();
  const present = (delay) => game.players.filter((p) => {
    const key = JSON.stringify([p.pos, p.look?.facing, p.look?.pitch]);
    const seen = stirred.get(p.name);
    if (!seen || seen.key !== key) stirred.set(p.name, { key, at: now() });
    return now() - stirred.get(p.name).at < delay;
  });
  const asleep = () => {
    const s = botSettings(db, config);
    if (napping) return true;
    const delay = s.sleepAfter * 60_000;
    return s.sleep && present(delay).length === 0 && now() - lastActivity >= delay;
  };
  async function idleTick() {
    const s = botSettings(db, config);
    if (idling || !s.idle.enabled || !game.connected || asleep()) return;
    // With sleep on, they work only while someone is in the game; off, always (within the limits).
    idling = true;
    try {
      await brain.idle?.((t, ch) => botSays(t, ch));
    } finally {
      idling = false;
    }
  }
  if (daily) setInterval(() => { idleTick().catch((err) => log.error('idle turn failed:', err)); }, 5000).unref();

  // Unfinished tasks go on in turns of their own (server/bot.mjs work), sleep or not: someone asked for them. The one who
  // asked hears when one is done or set aside, where they asked.
  let working = false;
  async function workTick() {
    if (working || !game.connected) return;
    working = true;
    try {
      await brain.work?.((t, ch, task) => botSays(t, ch, { near: task.source === 'game' ? task.by : undefined, toDiscord: task.source === 'discord' }));
    } finally {
      working = false;
    }
  }
  if (daily) setInterval(() => { workTick().catch((err) => log.error('task turn failed:', err)); }, 5000).unref();

  // ---- One person in two places: /link in the game gives a private code; /link in Discord with it joins them ----
  const linkCodes = new Map(); // code -> { gameId, name, at }

  function linkCode(name) {
    for (const [code, v] of linkCodes) if (now() - v.at > LINK_MS) linkCodes.delete(code);
    const code = randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
    linkCodes.set(code, { gameId: personId('game', name), name, at: now() });
    // Whispered: only the player sees it, so nobody else can claim their name on Discord.
    game.act({ type: 'say', to: name, from: host().name, color: host().chatColor, text: `In Discord, type  /link code:${code}  within 10 minutes `
      + 'and I will know you are the same person there.' });
  }

  /** Join a Discord user to the game player who was given `code`. Returns the answer to give them. */
  function linkWithCode(userId, userName, code) {
    const entry = linkCodes.get(String(code ?? '').trim().toUpperCase());
    if (!entry || now() - entry.at > LINK_MS) return 'That code is not one I gave out (or it ran out). Type /link in the game for a new one.';
    linkCodes.delete(String(code).trim().toUpperCase());
    const discordId = personId('discord', userId);
    db.meet(discordId, userName, { at: now(), talked: false });
    db.link(entry.gameId, discordId);
    for (const c of characters()) db.remember(c.id, entry.gameId, `Learned that ${userName} on Discord is ${entry.name} in game.`, 2, now());
    return `Got it, ${userName}: you and ${entry.name} in the game are one and the same to us now.`;
  }

  /**
   * /help (owner, 2026-10-27: "help to get a list of commands and instructions on how to play the game"): how to join,
   * who the characters are and how to talk to them, and every command, as one embed only the asker sees.
   */
  const helpEmbed = () => {
    const cast = characters();
    const field = (name, value) => ({ name, value: value.slice(0, 1024) });
    return {
      color: parseInt(String(host().chatColor ?? '#f2b84b').slice(1), 16) || 0xf2b84b,
      title: `How to play on ${config.serverName}`,
      description: `A Luanti world where ${cast.map((c) => `**${c.name}**`).join(' and ')} live, build their own projects, `
        + 'and remember everyone they meet.',
      url: `${config.publicUrl}/map`,
      fields: [
        field('🎮 Join the game', `1. Get Luanti, free: ${LUANTI_URL}\n2. Open it, go to **Join Game**\n`
          + `3. Address \`${config.gameAddress || new URL(config.publicUrl).hostname}\`, port \`${config.gamePort}\`\n`
          + '4. Pick a name and password, then **Register** (next time, **Login**)'),
        field('💬 Talk to the characters', `${cast.map((c) => `**${c.name}**: ${String(c.personality ?? '').split(/(?<=\.)\s/)[0]}`).join('\n')}\n`
          + 'Just chat, here or in the game. Say a name to talk to one; in the game you can also look at her. Ask them '
          + 'for help, items, or a build; how they treat you depends on how you treat them.'),
        field('🧭 Discord commands', '`/picture`: what the characters are up to (`who:Moss`, or `who:120 -40` for a spot)\n'
          + '`/map`: the live map\n`/link code:…`: join your game and Discord accounts\n`/help`: this guide'),
        field('⛏️ In-game commands', '`/talk <name> <message>`: talk to one character\n`/follow <name>`, `/come <name>`, '
          + '`/stay <name>`: move her\n`/rel`: how each one feels about you\n`/link`: a code for `/link` here'),
        field('🗺️ The map', `${config.publicUrl}/map: drag, zoom, slice the world open, click a block for its coordinates.`),
      ],
      footer: { text: 'Only you can see this.' },
    };
  };

  // Discord's slash commands (server/discord.mjs registers them): answered where they were typed.
  async function slash(c) {
    if (c.userId) db.meet(personId('discord', c.userId), c.userName, { at: now(), talked: false });
    if (c.name === 'help') return c.reply('', { ephemeral: true, embed: helpEmbed() });
    if (c.name === 'map') return c.reply(`The live map of the world: ${config.publicUrl}/map`);
    if (c.name === 'link') return c.reply(linkWithCode(c.userId, c.userName, c.options.code), { ephemeral: true });
    if (c.name === 'picture') {
      await c.defer();
      const r = await maps.pictures(c.options.who ?? '');
      if (r.error) return c.followup({ text: r.error });
      for (const p of r.pictures) {
        await c.followup({ png: p.png, filename: p.file, text: p.text, as: p.ch?.name, color: p.ch?.chatColor, link: `${config.publicUrl}/map` });
      }
    }
    return undefined;
  }

  function fromDiscord(m) {
    active();
    if (m.userId) db.meet(personId('discord', m.userId), m.name, { at: now() });
    db.addChat('discord', m.name, m.text, now());
    if (relay().chat) game.act({ type: 'say', text: m.text, from: `[Discord] ${m.name}` });
    // An admin on Discord is known by their Discord id, which Discord vouches for; a name anyone can type.
    const admin = Boolean(m.userId) && config.adminIds.includes(m.userId);
    brain.hear({ source: 'discord', name: m.name, text: m.text, admin,
      personId: m.userId ? personId('discord', m.userId) : undefined }, (t, ch) => botSays(t, ch, { toDiscord: true }))
      .catch((err) => log.error(err));
  }

  // ---- The daily summary: once a day at the bot's summary hour (UTC), to Discord and the game ----

  async function dailySummary({ force = false } = {}) {
    const s = botSettings(db, config);
    const t = new Date(now());
    const day = t.toISOString().slice(0, 10);
    if (!force && (s.summaryHour < 0 || t.getUTCHours() < s.summaryHour || db.setting('summary.last') === day)) return null;
    db.putSetting('summary.last', day);
    const sum = await brain.summary(now() - 24 * 3600_000);
    if (!sum) return null;
    const teller = sum.teller ?? host();
    // On Discord: an embed in the teller's colour, the day's title, a short scene, emoji bullets, a closing line.
    const date = t.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
    const body = [sum.opening, sum.bullets.length ? sum.bullets.map((b) => `${b.emoji} ${b.text}`).join('\n') : '',
      sum.closing ? `*${sum.closing}*` : ''].filter(Boolean).join('\n\n');
    await chat.post({ embed: { color: parseInt(String(teller.chatColor ?? '#f2b84b').slice(1), 16) || 0xf2b84b,
      author: { name: `${teller.name}'s daily tale` }, title: `📜 ${sum.title}`, description: codeCoords(body).slice(0, 3800),
      url: `${config.publicUrl}/map`, footer: { text: `${date} · more maps: ${config.publicUrl}/map` } } });
    // In the game: just the scene, and where to read the rest.
    const short = `${sum.title}: ${sum.opening}`.slice(0, 400);
    db.addChat('bot', teller.name, `${sum.title}. ${sum.opening} ${sum.bullets.map((b) => b.text).join(' ')} ${sum.closing}`, now());
    await game.act({ type: 'say', text: `${short} (the whole tale is on Discord)`, from: teller.name, by: teller.id, color: teller.chatColor });
    return body;
  }
  if (daily) setInterval(() => { dailySummary().catch((err) => log.error('daily summary failed:', err)); }, 10 * 60_000).unref();

  /**
   * Every player account on the game server (owner, 2026-10-27: "a drop down of players unlinked on the server side"):
   * names and last login from the world's auth.sqlite, read-only. Passwords are never read.
   */
  function gameAccounts() {
    const file = join(config.dataDir, 'world', 'auth.sqlite');
    if (!existsSync(file)) return [];
    let auth;
    try {
      auth = new DatabaseSync(file, { readOnly: true });
      return auth.prepare('SELECT name, last_login FROM auth ORDER BY last_login DESC LIMIT 500').all()
        .map((r) => ({ name: String(r.name), lastLogin: Number(r.last_login) * 1000 }));
    } catch (err) {
      log.error('reading game accounts failed:', err.message);
      return [];
    } finally {
      try { auth?.close(); } catch { /* closed */ }
    }
  }

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
      bot: { ready: brain.ready, name: characters().map((c) => c.name).join(', '), model: s.model, enabled: s.enabled, asleep: asleep() },
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
    // Older Activity, a page at a time, for the feed's endless scroll (owner, 2026-10-27: "some kind of infiniscroll").
    if (route === 'GET /api/admin/activity') {
      const p = url.searchParams;
      const kinds = FEED_KINDS[p.get('feed')] ?? null;
      return send(res, 200, { activity: db.activity({ before: Number(p.get('before')) || null, kinds, limit: Number(p.get('limit')) || 40 }) });
    }
    if (route === 'GET /api/admin') {
      return send(res, 200, {
        you, ...status(), settings: botSettings(db, config), relay: relay(), models: MODELS, efforts: EFFORTS,
        characters: castOf(db, config, now()).map((c) => ({ ...c, needsNow: needsOf(c, now()), traitsNow: traitsOf(c) })),
        people: db.people(100).map((p) => ({ ...p, color: db.colorOf(p.id) })),
        memories: db.allMemories(80),
        activity: db.activity({ limit: 40 }),
        // Every account on the game server, each saying who on Discord it is linked to, if anyone (Players lists them all
        // in its dropdown; owner: "drop down of users unlinked on the game server side").
        gameAccounts: gameAccounts().map((a) => {
          const p = db.person(personId('game', a.name));
          const row = p && db.people().find((x) => x.id === p.id);
          const discord = row && [{ id: row.id, name: row.name }, ...row.aliases].find((x) => x.id.startsWith('discord:'));
          return { ...a, linkedTo: discord ? discord.name : null };
        }),
        maps: { url: `${config.publicUrl}/map`, settings: maps.settings(), kept: db.json('maps', {}) },
        policyTools: TOOLS.filter((t) => t.permission && t.permission !== 'admin').map((t) => ({ name: t.name, permission: t.permission })),
        missing: config.missing, chat: db.chat(80), usage: db.usage(14),
        mcp: { url: `${config.publicUrl}/mcp`, hasToken: Boolean(config.mcpToken || db.setting('mcp.token')) },
        log: luanti?.log(80) ?? [],
      });
    }
    const body = req.method === 'POST' ? (await readBody(req)) ?? {} : {};
    if (route === 'POST /api/admin/bot') return send(res, 200, { settings: saveBotSettings(body) });
    if (route === 'POST /api/admin/sleep') return send(res, 200, sleepNow(body.on !== false));
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
    // A character's sheet: { id, ...fields } changes one (a new id adds it), { id, remove: true } removes it.
    if (route === 'POST /api/admin/character') {
      if (body.remove) {
        return removeCharacter(db, String(body.id), config) ? send(res, 200, { removed: true })
          : send(res, 400, { error: 'The last character cannot be removed.' });
      }
      const c = saveCharacter(db, String(body.id ?? ''), body, config);
      return c ? send(res, 200, { character: c }) : send(res, 400, { error: 'A new character needs a name (2 to 20 letters).' });
    }
    // Set how a character feels about someone, or forget them: { id, character, affinity?, trust?, nickname?, forget? }.
    if (route === 'POST /api/admin/person') {
      const p = typeof body.id === 'string' ? db.person(body.id) : null;
      if (!p) return send(res, 404, { error: 'No such person.' });
      if (body.forget) return send(res, 200, { forgotten: db.forget(p.id) });
      const ch = String(body.character ?? host().id);
      const b = db.bond(ch, p.id);
      db.feel(ch, p.id, Number.isFinite(Number(body.affinity)) ? Number(body.affinity) : b.affinity,
        Number.isFinite(Number(body.trust)) ? Number(body.trust) : b.trust);
      if (typeof body.nickname === 'string') db.nickname(ch, p.id, body.nickname.trim() || null);
      if (typeof body.color === 'string') db.setColor(p.id, body.color || null);
      if (['none', 'dating', 'ex'].includes(body.status)) db.setStatus(ch, p.id, body.status);
      return send(res, 200, { bond: db.bond(ch, p.id) });
    }
    // Join two people into one, as /link does: { keep, other } (ids); `other` becomes an alias of `keep`.
    if (route === 'POST /api/admin/link') {
      const a = typeof body.keep === 'string' ? db.person(body.keep) : null;
      // A game name typed on /admin: that player, made now if they have not joined yet.
      const typed = typeof body.gameName === 'string' && /^[\w-]{1,32}$/.test(body.gameName.trim()) ? body.gameName.trim() : null;
      if (typed) db.meet(personId('game', typed), typed, { at: now(), talked: false });
      const b = typed ? db.person(personId('game', typed)) : typeof body.other === 'string' ? db.person(body.other) : null;
      if (!a || !b) return send(res, 404, { error: 'No such person.' });
      if (!db.link(a.id, b.id)) return send(res, 400, { error: 'They are already one person.' });
      for (const c of characters()) db.remember(c.id, a.id, `Learned that ${b.name} is also ${a.name}.`, 2, now());
      return send(res, 200, { person: db.person(a.id) });
    }
    if (route === 'POST /api/admin/unlink') {
      return db.unlink(String(body.id ?? '')) ? send(res, 200, { ok: true }) : send(res, 400, { error: 'That account is not linked to anyone.' });
    }
    // Cancel a character's task: { character, id }.
    if (route === 'POST /api/admin/task') {
      const tasks = brain.tasksOf?.(String(body.character)) ?? [];
      if (!tasks.some((t) => t.id === body.id)) return send(res, 404, { error: 'No such task.' });
      brain.saveTasks(String(body.character), tasks.map((t) => (t.id === body.id && t.status === 'open' ? { ...t, status: 'cancelled', done: now() } : t)));
      return send(res, 200, { ok: true });
    }
    if (route === 'POST /api/admin/forget-memory') {
      return send(res, 200, { forgotten: db.dropMemory(Number(body.id)) });
    }
    // How often the characters' pictures go to Discord while someone is online, in minutes (0: never by themselves).
    if (route === 'POST /api/admin/maps') {
      const minutes = Math.max(0, Math.min(1440, Math.round(Number(body.every))));
      if (Number.isFinite(minutes)) db.putJson('maps.settings', { ...db.json('maps.settings', {}), minutes });
      return send(res, 200, { maps: maps.settings() });
    }
    // Post the characters' pictures to Discord now: { id } for one, nothing for all of them.
    if (route === 'POST /api/admin/map-post') {
      try { return send(res, 200, { posted: await maps.postNow(body.id ? String(body.id) : null) }); } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }
    if (route === 'POST /api/admin/map-now') {
      const ch = characters().find((c) => c.id === body.id);
      if (!ch) return send(res, 404, { error: 'No such character.' });
      const snap = await maps.snapshot(ch);
      return snap ? send(res, 200, { ok: true, file: snap.file }) : send(res, 400, { error: `${ch.name} is not in the world, or the game is down.` });
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
      return send(res, 200, { ...game.sync(body), bot: host().name, characters: bodies(), meters: meters() });
    }

    const ip = req.headers['fly-client-ip'] ?? req.socket.remoteAddress ?? '';
    // The public map: open to anyone, renders held to a few a minute per address (server/maps.mjs).
    if ((url.pathname === '/map' || url.pathname.startsWith('/map/')) && await maps.handle(req, res, url, ip)) return undefined;
    if (/^\/(api|auth|mcp)/.test(url.pathname) && limited(ip)) return send(res, 429, 'Slow down.');

    if (url.pathname === '/mcp') {
      if (!mcpAuthorized(req, { config, db })) {
        return send(res, 401, { error: 'Send Authorization: Bearer <token>; make one on /admin.' },
          { 'www-authenticate': 'Bearer' });
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'POST JSON-RPC here.' }, { allow: 'POST' });
      const msg = await readBody(req);
      if (!msg) return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Not JSON.' } });
      // talk(name, text): a word to one character from the builders (an admin), her answer back (owner, 2026-10-27:
      // "Tell bot via mcp that doors are available").
      const talk = async (name, text) => {
        const ch = characters().find((c) => c.name.toLowerCase() === String(name).toLowerCase());
        if (!ch) return { ok: false, message: `No character called ${name}.` };
        db.addChat('admin', 'Builders', `${ch.name}, ${text}`, now());
        const answer = await brain.hear({ source: 'game', name: 'Builders', text: `${ch.name}, ${text}`, admin: true, only: ch.id,
          personId: 'admin:builders' }, (t, who) => botSays(t, who, { toDiscord: true }));
        return { ok: true, message: answer ? `${ch.name}: ${answer}` : `${ch.name} did not answer.` };
      };
      // Restart the Luanti server (not the bot), only while nobody is playing unless forced.
      const restartGame = ({ force = false } = {}) => {
        if (!luanti) return { ok: false, message: 'This server does not run Luanti itself.' };
        if (game.players.length && !force) return { ok: false, message: `${game.players.length} playing now: not restarting (force to do it anyway).` };
        luanti.restart().catch((err) => log.error('restart failed:', err));
        return { ok: true, message: 'Restarting the game; back in about 20 seconds.' };
      };
      const ctx = { game, db, status, announce, maps, talk, restartGame, sleepNow, gameLog: (n) => luanti?.log(n) ?? [], settings: () => botSettings(db, config),
        saveSettings: saveBotSettings, resumeTask: (name) => brain.resumeTask?.(name) ?? null };
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
    // Which code is live: the bot's commit (a hot release, or the image's) and the image's. The deploy job reads it.
    if (route === 'GET /api/version') {
      return send(res, 200, { sha: process.env.BOT_SHA || process.env.GIT_SHA || null, image: process.env.GIT_SHA || null });
    }
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
  server.fromDiscord = fromDiscord;
  server.maps = maps;
  server.slash = slash;
  server.brain = brain;
  return server;
}
