// Discord, after RubenTipparach/rubens-solitare-collection's server/notifier.mjs: the server's news (up,
// joins, leaves) and its chat go to Discord channels, and with the bot, what people type in those channels
// comes back into the game, where the AI hears it too. Zero dependencies: the REST API through fetch, the
// Gateway through Node's own WebSocket.
//
// Two ways in (docs/deploy.md): the bot (DISCORD_BOT_TOKEN; its channels picked on /admin or set as
// DISCORD_CHANNEL_ID), both ways; or channel webhooks (DISCORD_WEBHOOK_URL), posts only. Either may name
// several channels. Off until one is set; the bot wins. Nothing it posts ever pings anyone.

/** A Discord channel webhook URL (Channel, Edit Channel, Integrations, Webhooks). */
export const WEBHOOK_URL =
  /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d{5,25}\/[\w-]+$/;
const isChannel = (id) => /^\d{5,25}$/.test(String(id));
// Guilds, guild messages, and the message content intent (switch it on in the Developer Portal, Bot page).
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);
export const COLORS = { up: 0x84e3b5, down: 0xfe6420, join: 0x1096c3, leave: 0x6b6b6b, bot: 0xfaaf5c };

/**
 * @param {{ token?: string, channelIds?: string[], webhookUrls?: string[], api?: string, fetchImpl?: typeof fetch,
 *           WebSocketImpl?: typeof WebSocket, onMessage?: (m: { channelId: string, userId: string, name: string, text: string }) => void,
 *           botName?: () => string, log?: Console }} opts
 */
export function createDiscord(opts = {}) {
  const {
    api = 'https://discord.com/api/v10', fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket, log = console,
    onMessage = () => {}, botName = () => 'Blocky',
  } = opts;
  const token = opts.token?.trim() ?? '';
  const webhooks = (opts.webhookUrls ?? []).filter((u) => WEBHOOK_URL.test(u));
  let channelIds = (opts.channelIds ?? []).filter(isChannel);
  const modeOf = () => (token && channelIds.length ? 'bot' : webhooks.length ? 'webhook' : null);
  const problemOf = () => (modeOf() ? null
    : token ? 'DISCORD_BOT_TOKEN is set: pick the bot\'s channels on this page.'
      : (opts.webhookUrls ?? []).length ? 'DISCORD_WEBHOOK_URL is set but is not a Discord webhook URL.'
        : 'Set DISCORD_BOT_TOKEN (then pick its channels here), or DISCORD_WEBHOOK_URL for posts only.');

  // A GET on Discord's API as the bot.
  async function asBot(path) {
    const res = await fetchImpl(`${api}${path}`, { headers: { authorization: `Bot ${token}` } });
    if (res.status === 401) throw new Error('Discord refused DISCORD_BOT_TOKEN.');
    if (!res.ok) throw new Error(`Discord said ${res.status}.`);
    return res.json();
  }

  /**
   * Post to every channel. message: { text } or { embed }, with `as` (who said it) and `color` ("#rrggbb"): a line
   * with a colour goes as a small embed, the name over a stripe of that colour, so each speaker is easy to pick out
   * (owner, 2026-10-27: "names from players in game are all the same color. Please assign colors to them").
   * Returns { ok, sent }.
   */
  async function post(message) {
    const mode = modeOf();
    if (!mode) return { ok: false, sent: 0 };
    const body = {
      allowed_mentions: { parse: [] },
      ...(message.embed ? { embeds: [message.embed] }
        : message.color && message.as ? { embeds: [{ color: parseInt(String(message.color).slice(1), 16) || 0x9aa8ff,
          author: { name: clean(message.as, 64) }, description: clean(message.text, 1900) }] }
          : { content: mode === 'bot' && message.as ? `**${clean(message.as, 64)}**: ${clean(message.text, 1800)}`
            : clean(message.text, 1900) }),
    };
    let sent = 0;
    // One after another, so a burst to several servers stays inside Discord's rate limits.
    for (const target of mode === 'bot' ? channelIds : webhooks) {
      try {
        const res = mode === 'bot'
          ? await fetchImpl(`${api}/channels/${target}/messages`, {
            method: 'POST', headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          : await fetchImpl(`${target}?wait=true`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...body, username: clean(message.as ?? 'Blocky Stuff', 80) }),
          });
        if (res.ok) sent++;
        else log.error(`discord post failed: ${res.status}`);
      } catch (err) {
        log.error('discord post failed:', err.message);
      }
    }
    return { ok: sent > 0, sent };
  }

  // ---- The Gateway: messages typed in the bot's channels ----
  let ws = null;
  let beat = null;
  let seq = null;
  let selfId = null;
  let stopped = true;
  let retry = 0;
  let connectedAt = 0;

  async function connect() {
    if (stopped || !token || !WebSocketImpl) return;
    let url;
    try {
      url = (await asBot('/gateway/bot')).url;
    } catch (err) {
      log.error('discord gateway:', err.message);
      return later();
    }
    ws = new WebSocketImpl(`${url}/?v=10&encoding=json`);
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      if (m.s !== null && m.s !== undefined) seq = m.s;
      if (m.op === 10) {
        clearInterval(beat);
        beat = setInterval(() => send({ op: 1, d: seq }), m.d.heartbeat_interval);
        send({ op: 2, d: { token, intents: INTENTS, properties: { os: 'linux', browser: 'blocky-stuff', device: 'blocky-stuff' } } });
      } else if (m.op === 1) {
        send({ op: 1, d: seq });
      } else if (m.op === 7 || m.op === 9) {
        ws.close(4000);
      } else if (m.op === 0 && m.t === 'READY') {
        selfId = m.d.user.id;
        retry = 0;
        connectedAt = Date.now();
        log.log(`Discord bot connected as ${m.d.user.username}.`);
      } else if (m.op === 0 && m.t === 'MESSAGE_CREATE') {
        heard(m.d);
      }
    };
    ws.onclose = (ev) => {
      clearInterval(beat);
      connectedAt = 0;
      // 4004: bad token; 4014: the message content intent is not switched on. Both need a person.
      if (ev.code === 4004 || ev.code === 4014) {
        log.error(ev.code === 4014 ? 'Discord: switch on the Message Content intent (Developer Portal, Bot).'
          : 'Discord refused DISCORD_BOT_TOKEN.');
        return;
      }
      later();
    };
    ws.onerror = () => {};
  }
  const send = (m) => { try { ws?.send(JSON.stringify(m)); } catch { /* closed: onclose reconnects */ } };
  function later() {
    if (stopped) return;
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 1000 * 2 ** retry);
  }

  function heard(d) {
    if (!channelIds.includes(String(d.channel_id)) || d.author?.bot || d.webhook_id) return;
    const name = d.member?.nick ?? d.author?.global_name ?? d.author?.username ?? 'someone';
    // A mention of the bot reads as its name, so "@Blocky" works from Discord as in game.
    const text = String(d.content ?? '').replace(new RegExp(`<@!?${selfId}>`, 'g'), `@${botName()}`)
      .replace(/<a?(:\w+:)\d+>/g, '$1').replace(/<[@#][!&]?\d+>/g, '@someone').trim();
    if (text) onMessage({ channelId: String(d.channel_id), userId: String(d.author?.id ?? ''), name: clean(name, 32), text: clean(text, 400) });
  }

  return {
    get mode() { return modeOf(); },
    get problem() { return problemOf(); },
    get channelIds() { return [...channelIds]; },
    /** Whether messages from Discord reach the game now. */
    get listening() { return connectedAt > 0; },
    get hasBot() { return Boolean(token); },
    /** Point the bot at its channels (the admin page's picks). False, changing nothing, when one is not an id. */
    setChannels(ids) {
      const next = [...new Set(ids.map(String))];
      if (!next.every(isChannel)) return false;
      channelIds = next;
      return true;
    },
    /** The text channels the bot can see, in every server it was added to: [{ id, name, server }]. */
    async channels() {
      if (!token) throw new Error('DISCORD_BOT_TOKEN is not set.');
      const out = [];
      for (const g of (await asBot('/users/@me/guilds')).slice(0, 20)) {
        for (const c of await asBot(`/guilds/${g.id}/channels`)) {
          if (c.type === 0 || c.type === 5) out.push({ id: String(c.id), name: c.name, server: g.name });
        }
      }
      return out;
    },
    post,
    /** A one-line news post as an embed: kind is a COLORS key. */
    news: (kind, text) => post({ embed: { color: COLORS[kind] ?? COLORS.bot, description: clean(text, 300) } }),
    start() { if (stopped) { stopped = false; connect(); } },
    stop() { stopped = true; clearInterval(beat); try { ws?.close(1000); } catch { /* already closed */ } },
  };
}

/** One line of player text: no newlines, code or markdown links, bounded. */
export const clean = (s, max) => String(s ?? '').replace(/[\r\n`|]+/g, ' ').replace(/\]\(/g, '] (').replace(/\s+/g, ' ')
  .trim().slice(0, max);
