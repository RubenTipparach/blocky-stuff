// The admin page, served at /admin, after RubenTipparach/rubens-solitare-collection's: one self-contained
// page. Sign in with Discord (back to this page with the link in the address's fragment), then tabs (owner,
// 2026-10-27: "a nicer ui, instead of just adding more panels, tab categories"): Overview (the server, who is
// online, the chat), Characters (each one's sheet and memories), Relationships (how each character feels about
// each person, as meters with sliders to change and save), Activity (what they heard and did, the game's log) and
// Settings (the bot, Discord, MCP, what the LLM has cost). It talks to /api/admin with the link as a
// bearer token; the server checks the Discord id against ADMIN_DISCORD_ID on every call. The live parts refresh
// every few seconds; the forms are filled once, so a refresh never eats what you are typing.

export const ADMIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blocky Stuff admin</title>
<style>
  :root { color-scheme: dark; --bg: #12150f; --panel: #232a1f; --line: #344030; --text: #f4f7ef; --muted: #a9b89a;
    --accent: #8fd16a; --warn: #f2b84b; --bad: #ff6b4a; --blue: #4aa3df; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 16px; }
  h1 { color: var(--accent); font-size: 22px; margin: 4px 0 12px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  h1 .who { margin-left: auto; font-size: 14px; color: var(--muted); font-weight: 400; }
  h2 { color: var(--accent); font-size: 17px; margin: 0 0 10px; }
  section { background: var(--panel); border-radius: 10px; padding: 14px 16px; margin: 0 0 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }
  .grid > section { margin: 0; }
  .muted { color: var(--muted); } .ok { color: var(--accent); } .bad { color: var(--bad); } .warn { color: var(--warn); }
  button, select, input, textarea { font: inherit; border-radius: 8px; border: 0; padding: 8px 12px; min-height: 38px; }
  input, select, textarea { background: #182015; color: var(--text); border: 1px solid var(--line); width: 100%; }
  textarea { min-height: 90px; resize: vertical; }
  input[type=checkbox] { width: auto; min-height: 0; }
  button { background: var(--blue); color: #fff; cursor: pointer; }
  button.quiet { background: #3a4636; } button.danger { background: #8c2a24; }
  button:disabled { opacity: 0.4; cursor: default; }
  a.button { display: inline-block; background: var(--blue); color: #fff; padding: 10px 14px; border-radius: 8px; text-decoration: none; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { color: var(--muted); font-weight: 600; }
  .scroll { overflow-x: auto; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .row > input { flex: 1 1 200px; width: auto; }
  dl.status { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 0; }
  dl.status dt { color: var(--muted); } dl.status dd { margin: 0; overflow-wrap: anywhere; }
  label.field { display: grid; gap: 4px; margin: 0 0 10px; color: var(--muted); font-size: 13px; }
  label.check { display: flex; gap: 8px; align-items: center; margin: 0 0 6px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .three { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
  .chat { max-height: 340px; overflow-y: auto; font-size: 14px; display: grid; gap: 3px; margin: 0 0 10px; }
  .chat .src { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin-right: 6px; }
  .chat .bot b { color: var(--warn); } .chat .discord b { color: #9aa8ff; } .chat .admin b { color: var(--bad); }
  pre { background: #0c0f0a; border-radius: 8px; padding: 10px; overflow: auto; max-height: 320px; font-size: 12px; margin: 0; white-space: pre-wrap; }
  code.copy { display: block; background: #0c0f0a; padding: 8px 10px; border-radius: 8px; overflow-wrap: anywhere; font-size: 13px; margin: 6px 0; }
  .note { margin: 6px 0 0; font-size: 13px; }
  img.av { width: 24px; height: 24px; border-radius: 50%; vertical-align: middle; }
  nav.tabs { display: flex; gap: 4px; flex-wrap: wrap; margin: 0 0 14px; border-bottom: 1px solid var(--line); }
  nav.tabs button { background: none; color: var(--muted); border-radius: 8px 8px 0 0; padding: 10px 16px; font-weight: 600; }
  nav.tabs button.on { background: var(--panel); color: var(--accent); }
  .tab { display: none; } .tab.on { display: block; }
  .pills { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 12px; }
  .pills button { background: #2e3829; color: var(--text); border: 2px solid transparent; }
  .pills button.on { border-color: var(--accent); background: #34432c; }
  .pills .dot, .rel .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .rels { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 12px; }
  .rel { background: #1b2217; border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; display: grid; gap: 8px; }
  .rel.dirty { border-color: var(--warn); }
  .rel-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .rel-head b { font-size: 16px; }
  .badge { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; padding: 2px 8px; border-radius: 999px; background: #3a4636; color: var(--muted); }
  .badge.dating { background: #5a2a44; color: #ffb3d9; } .badge.ex { background: #3a3a3a; }
  .meter { display: grid; grid-template-columns: 54px 1fr 116px; gap: 8px; align-items: center; font-size: 13px; }
  .meter .lab { color: var(--muted); } .meter output { text-align: right; font-weight: 600; }
  input[type=range] { -webkit-appearance: none; appearance: none; height: 10px; border-radius: 999px; padding: 0; min-height: 0; border: 0; }
  input[type=range].aff { background: linear-gradient(to right, #c0392b, #e67e22 30%, #7f8c7a 50%, #8fd16a 75%, #2ecc71); }
  input[type=range].tru { background: linear-gradient(to right, #4a4f46, #4aa3df); }
  input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; border-radius: 50%; background: #fff; border: 2px solid #12150f; cursor: pointer; }
  input[type=range]::-moz-range-thumb { width: 16px; height: 16px; border-radius: 50%; background: #fff; border: 2px solid #12150f; cursor: pointer; }
  .rel .facts { font-size: 12px; color: var(--muted); }
  .rel details summary { cursor: pointer; color: var(--muted); font-size: 13px; }
  .rel details[open] { display: grid; gap: 8px; }
  @media (max-width: 560px) { .two, .three { grid-template-columns: 1fr; } .meter { grid-template-columns: 52px 1fr 96px; } }
</style></head>
<body><main>
<h1>Blocky Stuff admin <span class="who" id="who"></span></h1>
<div id="app" class="muted">Loading...</div>
</main>
<script>
const KEY = 'blocky.admin';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (t) => (t ? new Date(t).toLocaleString() : '');
const clock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const store = { get: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
  set: (v) => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch {} } };
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.get('blocky_token')) store.set(hash.get('blocky_token'));
const signInError = hash.get('blocky_error');
if (location.hash) history.replaceState(null, '', location.pathname);
const app = document.getElementById('app');
const $ = (id) => document.getElementById(id);

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: 'Bearer ' + (store.get() || ''), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || ('HTTP ' + res.status)), { status: res.status, data });
  return data;
}

function signIn(message) {
  const back = encodeURIComponent(location.origin + '/admin');
  app.innerHTML = '<section><h2>Sign in</h2>' + (message ? '<p class="bad">' + esc(message) + '</p>' : '')
    + '<p class="muted">Admins sign in with Discord. Your Discord id must be in the ADMIN_DISCORD_ID secret.</p>'
    + '<a class="button" href="/auth/discord/login?return=' + back + '">Sign in with Discord</a></section>';
}

let state = null;
let picked = ''; // the character shown on Characters and Relationships
let pickCharacter = () => {};
const feelsWord = (a) => a <= -60 ? 'hostile' : a <= -25 ? 'dislike' : a < -5 ? 'wary' : a < 15 ? 'neutral' : a < 35 ? 'friendly' : a < 60 ? 'fond' : a < 85 ? 'close friend' : 'best friend';
const trustWordOf = (t) => t < 15 ? 'none' : t < 35 ? 'low' : t < 60 ? 'some' : t < 80 ? 'high' : 'complete';
const signed = (n) => (Number(n) > 0 ? '+' : '') + Number(n);
const agoOf = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };

// The Relationships tab: the character's pills, then a card per person she knows, meters as sliders. Drawn when
// asked (tab opened, character picked, after a save), and by the refresh only while no card has unsaved changes and
// nothing in it has focus, so a slider being dragged or a picker being opened is never wiped.
function renderRelationships(force) {
  if (!state || !$('rel')) return;
  const box = $('rel');
  if (!force && (box.querySelector('.rel.dirty') || box.contains(document.activeElement))) return;
  const list = state.characters;
  const me = list.find((c) => c.id === picked) || list[0];
  if (!me) { box.innerHTML = '<p class="muted">No characters.</p>'; return; }
  $('relPick').innerHTML = list.map((c) => '<button data-pick="' + esc(c.id) + '" class="' + (c.id === me.id ? 'on' : '') + '"><span class="dot" style="background:'
    + esc(c.chatColor) + '"></span>' + esc(c.name) + (c.enabled === false ? ' (away)' : '') + '</button>').join('');
  const partner = state.people.find((p) => p.bonds && p.bonds[me.id] && p.bonds[me.id].status === 'dating');
  $('relHead').innerHTML = 'How <b>' + esc(me.name) + '</b> feels about everyone she knows. Mood: ' + esc(me.mood.label)
    + (partner ? ' · Dating <b>' + esc(partner.name) + '</b>' : '') + (me.project ? ' · Building ' + esc(me.project.title) : '');
  const kind = (id) => (id.startsWith('discord:') ? 'Discord' : id.startsWith('char:') ? 'Character' : 'Game');
  const people = state.people.filter((p) => p.id !== 'char:' + me.id);
  const strangers = people.filter((p) => !p.id.startsWith('char:'));
  box.innerHTML = people.length ? people.map((p) => {
    const b = (p.bonds && p.bonds[me.id]) || { affinity: 0, trust: 20, nickname: null, facts: [], status: 'none' };
    const char = p.id.startsWith('char:');
    const where = [p, ...(p.aliases || [])].map((x) => kind(x.id) + ': ' + esc(x.name)).join(' · ');
    const pool = strangers.filter((o) => o.id !== p.id);
    return '<div class="rel" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '">'
      + '<div class="rel-head"><span class="dot" style="background:' + esc(p.color || '#9aa8ff') + '"></span><b>' + esc(p.name) + '</b>'
      + (b.status === 'dating' ? '<span class="badge dating">dating</span>' : b.status === 'ex' ? '<span class="badge ex">ex</span>' : '')
      + '<span class="muted note" style="margin:0">' + where + '</span></div>'
      + '<div class="muted note" style="margin:0">' + p.talks + ' talks · last seen ' + agoOf(p.last_at) + '</div>'
      + '<div class="meter"><span class="lab">Affinity</span><input type="range" class="aff" min="-100" max="100" value="' + b.affinity + '">'
      + '<output class="affOut">' + feelsWord(b.affinity) + ' (' + signed(b.affinity) + ')</output></div>'
      + '<div class="meter"><span class="lab">Trust</span><input type="range" class="tru" min="0" max="100" value="' + b.trust + '">'
      + '<output class="truOut">' + trustWordOf(b.trust) + ' (' + b.trust + ')</output></div>'
      + '<div class="two"><label class="field" style="margin:0">Nickname<input class="nick" maxlength="32" value="' + esc(b.nickname || '') + '"></label>'
      + '<label class="field" style="margin:0">Status<select class="status">' + ['none', 'dating', 'ex'].map((s) => '<option'
        + (b.status === s ? ' selected' : '') + '>' + s + '</option>').join('') + '</select></label></div>'
      + (b.facts.length ? '<div class="facts">' + b.facts.map(esc).join(' · ') + '</div>' : '')
      + '<div class="row"><button data-save disabled>Save</button><span class="relNote note muted" style="margin:0"></span></div>'
      + '</div>';
  }).join('') : '<p class="muted">Nobody yet: the characters meet people as they chat.</p>';
}
// The Players tab: each person once, their accounts by kind, and only the links that make sense: a person with game
// accounts but none on Discord may be linked to someone who is only on Discord, and the other way round.
function renderPlayers(force) {
  if (!state || !$('players2')) return;
  const box = $('players2');
  if (!force && box.contains(document.activeElement)) return;
  const people = state.people.filter((p) => !p.id.startsWith('char:'));
  const accounts = (p) => [{ id: p.id, name: p.name, alias: false }, ...(p.aliases || []).map((a) => ({ ...a, alias: true }))];
  const kindOf = (p) => { const ids = accounts(p).map((a) => a.id); return { game: ids.some((i) => i.startsWith('game:')), discord: ids.some((i) => i.startsWith('discord:')) }; };
  const list = (p, prefix) => accounts(p).filter((a) => a.id.startsWith(prefix)).map((a) => esc(a.name)
    + (a.alias ? ' <button class="quiet" style="min-height:26px;padding:2px 8px;font-size:12px" data-unlink="' + esc(a.id) + '">Unlink</button>' : '')).join('<br>');
  box.innerHTML = people.length ? people.map((p) => {
    const k = kindOf(p);
    const missing = k.game && !k.discord ? 'discord' : k.discord && !k.game ? 'game' : null;
    const pool = missing ? people.filter((o) => o.id !== p.id && (() => { const ok = kindOf(o); return missing === 'discord' ? ok.discord && !ok.game : ok.game && !ok.discord; })()) : [];
    const picker = missing ? (pool.length ? '<div class="row" style="margin-top:4px"><select class="linkWith" style="width:auto;min-height:32px">'
      + '<option value="">Link a ' + (missing === 'game' ? 'game player' : 'Discord user') + '...</option>'
      + pool.map((o) => '<option value="' + esc(o.id) + '">' + esc(o.name) + '</option>').join('') + '</select>'
      + '<button class="quiet" data-link style="min-height:32px">Link</button></div>'
      : '<span class="muted note">no unlinked ' + (missing === 'game' ? 'game players' : 'Discord users') + ' yet</span>') : '';
    const cell = (prefix) => (list(p, prefix) || '<span class="muted">none</span>') + (missing === (prefix === 'game:' ? 'game' : 'discord') ? picker : '');
    return '<tr data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '"><td><span class="dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;background:'
      + esc(p.color || '#9aa8ff') + '"></span><b>' + esc(p.name) + '</b></td><td>' + cell('game:') + '</td><td>' + cell('discord:') + '</td><td>' + p.talks
      + '</td><td class="muted">' + agoOf(p.last_at) + '</td><td class="row"><input type="color" class="color" style="width:46px;min-height:32px;padding:2px" value="'
      + esc(p.color || '#9aa8ff') + '"><button class="quiet" data-color style="min-height:32px">Save</button></td>'
      + '<td><button class="danger" data-forget style="min-height:32px">Forget</button></td></tr>';
  }).join('') : '<tr><td colspan="7" class="muted">Nobody yet: people show up here once they chat.</td></tr>';
}
let built = false;

async function load() {
  if (!store.get()) return signIn(signInError);
  try {
    state = await api('/api/admin');
  } catch (e) {
    if (e.status === 401) { store.set(null); return signIn(signInError || 'Your sign-in ran out: sign in again.'); }
    if (e.status === 403) {
      const you = e.data.you || {};
      app.innerHTML = '<section><h2>Not an admin</h2><p>You are signed in as <b>' + esc(you.name) + '</b>, Discord id <code>'
        + esc(you.id) + '</code>. Add that id to the <code>ADMIN_DISCORD_ID</code> secret (GitHub, then deploy; or '
        + '<code>fly secrets set</code>) and reload.</p><button class="quiet" id="out">Sign out</button></section>';
      $('out').onclick = () => { store.set(null); signIn(); };
      return;
    }
    app.innerHTML = '<section class="bad">Could not load: ' + esc(e.message) + '</section>';
    return;
  }
  if (!built) build();
  refresh();
}

function build() {
  built = true;
  const s = state.settings;
  $('who').innerHTML = (state.you.avatar ? '<img class="av" src="' + esc(state.you.avatar) + '" alt=""> ' : '')
    + esc(state.you.name) + ' <button class="quiet" id="out">Sign out</button>';
  $('out').onclick = () => { store.set(null); location.reload(); };
  app.innerHTML = \`
<nav class="tabs" id="tabs">
  <button data-tab="overview">Overview</button><button data-tab="characters">Characters</button>
  <button data-tab="relationships">Relationships</button><button data-tab="players">Players</button><button data-tab="activity">Activity</button>
  <button data-tab="settings">Settings</button>
</nav>
<div class="tab" data-panel="overview">
<div class="grid">
  <section><h2>Server</h2><dl class="status" id="status"></dl>
    <div class="row" style="margin-top:12px"><button class="quiet" id="restart">Restart Luanti</button><span id="restartNote" class="muted note"></span></div></section>
  <section><h2>Online</h2><div class="scroll"><table><thead><tr><th>Player</th><th>Position</th><th>HP</th><th></th></tr></thead>
    <tbody id="players"></tbody></table></div></section>
</div>
<section style="margin-top:14px"><h2>Chat</h2><div class="chat" id="chat"></div>
  <form class="row" id="announce"><input id="announceText" maxlength="400" placeholder="Say something to everyone, as the server">
  <button>Send</button></form></section>
</div>
<div class="tab" data-panel="settings">
<div class="grid">
  <section><h2>The bot</h2><form id="bot">
    <label class="check"><input type="checkbox" id="b_enabled"> The characters answer in chat</label>
    <div class="two"><label class="field">Effort<select id="b_effort">\${state.efforts.map((e) => '<option>' + e + '</option>').join('')}</select></label>
    <label class="field">Model<select id="b_model">\${[...new Set([...state.models, s.model])].map((m) => '<option>' + esc(m) + '</option>').join('')}</select></label></div>
    <div class="two"><label class="field">Listens to<select id="b_listen"><option value="mentions">Only messages that say its name</option>
      <option value="all">Every chat message (it joins in when it has something to say)</option></select></label>
    <label class="field">Daily summary at (UTC hour, -1 = off)<input id="b_summaryHour" type="number" min="-1" max="23"></label></div>
    <div class="three"><label class="field">Cooldown (s)<input id="b_cooldown" type="number" min="0"></label>
    <label class="field">Per player / hour<input id="b_perHour" type="number" min="0"></label>
    <label class="field">Calls / day (0 = no limit)<input id="b_perDay" type="number" min="0"></label></div>
    <label class="check"><input type="checkbox" id="b_romance"> Romance: characters fond of someone may flirt, and date (always PG)</label>
    <label class="check"><input type="checkbox" id="b_pranks"> Pranks: characters hostile to someone may drop a few harmless blocks on their build, once a day</label>
    <label class="check"><input type="checkbox" id="b_idle"> They work on their own projects when nobody is asking them anything (while someone is online, and for an hour after anyone's last word)</label>
    <div class="two"><label class="field">A turn when not asked anything for (seconds)<input id="b_idleAfter" type="number" min="15"></label>
    <label class="field">Own turns per hour, at most (all together)<input id="b_idlePerHour" type="number" min="0"></label></div>
    <div class="muted note" style="margin:0 0 6px">Players who are not admins may ask for:</div>
    <div id="policy"></div>
    <div class="row" style="margin-top:10px"><button>Save</button><button type="button" class="quiet" id="summaryNow">Post today's summary now</button>
      <span id="botNote" class="note muted"></span></div>
    <p class="note muted">Listening to every message makes an LLM call per chat line, held to the limits above.</p>
    <p class="note muted">Admins (the <code>server</code> privilege in game) may ask for anything, for anyone. On Discord, only the ids in ADMIN_DISCORD_ID count as admins.</p>
  </form></section>
  <section><h2>Discord</h2><dl class="status" id="discord"></dl>
    <div id="channels" style="margin:10px 0"></div>
    <div class="row"><button class="quiet" id="loadChannels">Pick channels</button><button class="quiet" id="discordTest">Test post</button>
    <span id="discordNote" class="note muted"></span></div>
    <h2 style="margin-top:16px">Relay</h2>
    <label class="check"><input type="checkbox" id="r_chat"> Chat both ways (game, Discord, bot)</label>
    <label class="check"><input type="checkbox" id="r_news"> Joins, leaves and server start</label>
    <h2 style="margin-top:16px">Map pictures</h2>
    <p class="muted note" style="margin:0 0 8px">A picture of each character, aimed at where she is, goes to Discord every so often while someone is in the game (a finished project gets a mention). Anyone in the channel can ask with <code>!map</code>, <code>!map Moss</code> or <code>!map 120 -40</code>.</p>
    <div class="row"><label class="field" style="margin:0;flex:1 1 200px">Every (minutes, while someone is online; 0 = never by themselves)<input id="m_every" type="number" min="0" max="1440"></label>
      <button type="button" class="quiet" id="m_save" style="align-self:end">Save</button>
      <button type="button" class="quiet" id="m_post" style="align-self:end">Post everyone's picture now</button><span id="m_note" class="note muted"></span></div>
  </section>
</div>
<div class="grid" style="margin-top:14px">
  <section><h2>MCP</h2><p class="muted note">Run the world from Claude Code, Claude Desktop or any MCP client.</p>
    <code class="copy">\${esc(state.mcp.url)}</code>
    <div class="row"><button class="quiet" id="mcpToken">\${state.mcp.hasToken ? 'Make a new token (the old one stops working)' : 'Make a token'}</button></div>
    <div id="mcpOut"></div></section>
  <section><h2>LLM use</h2><div class="scroll"><table><thead><tr><th>Day (UTC)</th><th>Calls</th><th>Input</th><th>Output</th></tr></thead>
    <tbody id="usage"></tbody></table></div></section>
</div>
</div>
<div class="tab" data-panel="characters">
<section><h2>Characters</h2>
  <div class="row" style="margin-bottom:10px"><select id="c_pick" style="width:auto"></select>
    <button type="button" class="quiet" id="c_new">Add a character</button></div>
  <p class="muted note" id="moodLine"></p>
  <form id="character">
    <div class="three"><label class="field">Name (players say @name)<input id="c_name" maxlength="20"></label>
    <label class="field">Pronouns<input id="c_pronouns" maxlength="20"></label>
    <label class="check" style="align-self:end"><input type="checkbox" id="c_enabled"> In the world</label></div>
    <div class="three"><label class="field">Name colour in chat<input type="color" id="c_chatColor"></label>
    <label class="field">Dress<input type="color" id="c_dressColor"></label>
    <label class="field">Hair<input type="color" id="c_hairColor"></label></div>
    <label class="field">Backstory<textarea id="c_backstory" maxlength="3000"></textarea></label>
    <div class="two"><label class="field">Personality<textarea id="c_personality" maxlength="3000"></textarea></label>
    <label class="field">How she talks<textarea id="c_speech" maxlength="3000"></textarea></label></div>
    <label class="field">What she wants in life<textarea id="c_goals" maxlength="3000"></textarea></label>
    <label class="field">Working on now (she changes this herself)<input id="c_goal" maxlength="200"></label>
    <div class="row"><button>Save character</button><button type="button" class="quiet" id="resetMood">Calm her mood</button>
      <button type="button" class="quiet" id="c_post">Take a picture and post it</button>
      <button type="button" class="danger" id="c_remove">Remove</button><span id="charNote" class="note muted"></span></div>
  </form></section>
<section style="margin-top:14px"><h2>Her memories</h2><div class="scroll"><table><thead><tr><th>When</th><th>About</th><th>Memory</th><th>Weight</th><th></th></tr></thead>
  <tbody id="memories"></tbody></table></div></section>
</div>
<div class="tab" data-panel="relationships">
<section><h2>Relationships</h2>
  <div class="pills" id="relPick"></div>
  <p class="muted note" id="relHead" style="margin:0 0 12px"></p>
  <div class="rels" id="rel"></div>
  <p class="muted note">Characters move these a little at a time as people treat them well or badly. Drag a slider and press Save to set one yourself.
  Accounts, colours and linking are on the Players tab.</p>
</section>
</div>
<div class="tab" data-panel="players">
<section><h2>Players</h2>
  <p class="muted note" style="margin:0 0 12px">Each person once, with the game and Discord accounts that are theirs. Someone with only one kind can be linked to a
  person who has only the other kind (players can also do it themselves: <code>!link</code> in game, then the code in Discord). Unlink undoes a wrong link.</p>
  <div class="scroll"><table><thead><tr><th>Person</th><th>In game</th><th>On Discord</th><th>Talks</th><th>Last seen</th><th>Colour on Discord</th><th></th></tr></thead>
  <tbody id="players2"></tbody></table></div>
  <p class="note muted" id="playersNote"></p>
</section>
</div>
<div class="tab" data-panel="activity">
<section><h2>Activity</h2>
  <p class="muted note">What the characters heard and did lately, newest first: who answered, who stayed quiet and why, their own turns, errors.</p>
  <div class="scroll"><table><thead><tr><th>When</th><th>What</th><th>Who</th><th>From</th><th></th></tr></thead>
  <tbody id="activity"></tbody></table></div></section>
<section style="margin-top:14px"><h2>Luanti log</h2><pre id="log"></pre></section>
</div>\`;
  // Tabs: the last one open is remembered on this device.
  const show = (name) => {
    for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === name);
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t.dataset.panel === name);
    try { localStorage.setItem('blocky.tab', name); } catch {}
    if (name === 'relationships') renderRelationships(true);
    if (name === 'players') renderPlayers(true);
  };
  $('tabs').onclick = (ev) => { const b = ev.target.closest('button[data-tab]'); if (b) show(b.dataset.tab); };
  let first = hash.get('tab') || 'overview';
  try { first = hash.get('tab') || localStorage.getItem('blocky.tab') || 'overview'; } catch {}
  show(document.querySelector('[data-panel="' + first + '"]') ? first : 'overview');
  const FIELDS = ['name', 'pronouns', 'chatColor', 'dressColor', 'hairColor', 'backstory', 'personality', 'speech', 'goals'];
  const fillCharacter = () => {
    const list = state.characters;
    if (!list.some((c) => c.id === picked)) picked = list[0] ? list[0].id : '';
    $('c_pick').innerHTML = list.map((c) => '<option value="' + esc(c.id) + '"' + (c.id === picked ? ' selected' : '') + '>'
      + esc(c.name) + (c.enabled === false ? ' (away)' : '') + '</option>').join('');
    const c = list.find((x) => x.id === picked);
    if (!c) return;
    for (const f of FIELDS) $('c_' + f).value = c[f] || '';
    $('c_enabled').checked = c.enabled !== false;
    $('c_goal').value = c.goal || '';
  };
  pickCharacter = (id) => { picked = id; fillCharacter(); refresh(); renderRelationships(true); };
  fillCharacter();
  $('c_pick').onchange = () => pickCharacter($('c_pick').value);
  $('relPick').onclick = (ev) => { const b = ev.target.closest('button[data-pick]'); if (b) pickCharacter(b.dataset.pick); };
  $('c_new').onclick = async () => {
    const name = prompt('Her name (2 to 20 letters):');
    if (!name) return;
    try { const r = await api('/api/admin/character', { id: '', name }); picked = r.character.id; await load(); fillCharacter(); }
    catch (e) { alert(e.message); }
  };
  $('c_remove').onclick = async () => {
    const c = state.characters.find((x) => x.id === picked);
    if (!c || !confirm('Remove ' + c.name + ' for good? Her feelings and memories go with her. (To send her away for a while, untick In the world instead.)')) return;
    try { await api('/api/admin/character', { id: picked, remove: true }); picked = ''; await load(); fillCharacter(); } catch (e) { alert(e.message); }
  };
  $('character').onsubmit = async (ev) => {
    ev.preventDefault();
    const body = { id: picked, enabled: $('c_enabled').checked, goal: $('c_goal').value };
    for (const f of FIELDS) body[f] = $('c_' + f).value;
    try { await api('/api/admin/character', body); $('charNote').textContent = 'Saved.'; await load(); fillCharacter(); }
    catch (e) { $('charNote').textContent = e.message; }
  };
  $('resetMood').onclick = async () => { await api('/api/admin/character', { id: picked, resetMood: true }).catch(() => {}); refreshSoon(); };
  // Relationship cards: a slider moved marks its card unsaved (and holds off the refresh) until Save.
  $('rel').addEventListener('input', (ev) => {
    const card = ev.target.closest('.rel');
    if (!card) return;
    card.classList.add('dirty');
    card.querySelector('[data-save]').disabled = false;
    if (ev.target.classList.contains('aff')) card.querySelector('.affOut').textContent = feelsWord(Number(ev.target.value)) + ' (' + signed(ev.target.value) + ')';
    if (ev.target.classList.contains('tru')) card.querySelector('.truOut').textContent = trustWordOf(Number(ev.target.value)) + ' (' + ev.target.value + ')';
  });
  $('rel').addEventListener('change', (ev) => { const card = ev.target.closest('.rel'); if (card && ev.target.matches('select.status, input.nick')) { card.classList.add('dirty'); card.querySelector('[data-save]').disabled = false; } });
  $('rel').addEventListener('click', async (ev) => {
    const card = ev.target.closest('.rel');
    if (!card) return;
    const id = card.dataset.id;
    const note = card.querySelector('.relNote');
    if (ev.target.closest('[data-save]')) {
      try {
        await api('/api/admin/person', { id, character: picked, affinity: Number(card.querySelector('.aff').value),
          trust: Number(card.querySelector('.tru').value), nickname: card.querySelector('.nick').value,
          status: card.querySelector('.status').value });
        card.classList.remove('dirty');
        note.textContent = 'Saved.';
        await load();
        renderRelationships(true);
      } catch (e) { note.textContent = e.message; }
    } else if (ev.target.closest('[data-color]')) {
      try { await api('/api/admin/person', { id, character: picked, color: card.querySelector('.color').value }); note.textContent = 'Colour saved.'; await load(); }
      catch (e) { note.textContent = e.message; }
    } else if (ev.target.closest('[data-link]')) {
      const sel = card.querySelector('.linkWith');
      if (!sel.value) { note.textContent = 'Pick who to join with first.'; return; }
      if (!confirm('Make ' + sel.options[sel.selectedIndex].text + ' the same person as ' + card.dataset.name + '? The feelings on this card stay; talks, facts and memories join.')) return;
      try { await api('/api/admin/link', { keep: id, other: sel.value }); await load(); renderRelationships(true); } catch (e) { note.textContent = e.message; }
    } else if (ev.target.closest('[data-forget]')) {
      if (!confirm('Forget ' + card.dataset.name + ' completely, for every character: feelings, facts and memories?')) return;
      try { await api('/api/admin/person', { id, forget: true }); await load(); renderRelationships(true); } catch (e) { note.textContent = e.message; }
    }
  });

  $('b_enabled').checked = s.enabled; $('b_model').value = s.model; $('b_effort').value = s.effort;
  $('b_cooldown').value = s.cooldown; $('b_perHour').value = s.perHour; $('b_perDay').value = s.perDay;
  $('b_listen').value = s.listen; $('b_summaryHour').value = s.summaryHour;
  $('b_romance').checked = s.romance; $('b_pranks').checked = s.pranks;
  $('b_idle').checked = s.idle.enabled; $('b_idleAfter').value = s.idle.after; $('b_idlePerHour').value = s.idle.perHour;
  const perms = [...new Map(state.policyTools.map((t) => [t.permission, t])).keys()];
  const label = { give: 'Items for themselves', teleport: 'Teleporting themselves', heal: 'Healing themselves', time: 'Changing the time of day', build: 'Building (placing blocks)' };
  $('policy').innerHTML = perms.map((p) => '<label class="check"><input type="checkbox" data-perm="' + p + '"' + (s.policy[p] ? ' checked' : '')
    + '> ' + esc(label[p] || p) + '</label>').join('');
  $('r_chat').checked = state.relay.chat; $('r_news').checked = state.relay.news;
  $('m_every').value = state.maps.settings.every;
  $('m_save').onclick = async () => {
    try { await api('/api/admin/maps', { every: Number($('m_every').value) }); $('m_note').textContent = 'Saved.'; } catch (e) { $('m_note').textContent = e.message; }
  };
  const postMap = async (id, note) => {
    note.textContent = 'Drawing and posting...';
    try { const r = await api('/api/admin/map-post', id ? { id } : {}); note.textContent = r.posted ? 'Posted ' + r.posted + ' picture' + (r.posted === 1 ? '' : 's') + '.' : 'Nothing posted: is she in the world?'; }
    catch (e) { note.textContent = e.message; }
  };
  $('m_post').onclick = () => postMap(null, $('m_note'));
  $('c_post').onclick = () => postMap(picked, $('charNote'));
  // Players: link the missing kind of account, unlink, colour, forget.
  $('players2').addEventListener('click', async (ev) => {
    const row = ev.target.closest('tr[data-id]');
    if (!row) return;
    const note = $('playersNote');
    try {
      if (ev.target.closest('[data-link]')) {
        const sel = row.querySelector('select.linkWith');
        if (!sel || !sel.value) { note.textContent = 'Pick the account to link first.'; return; }
        await api('/api/admin/link', { keep: row.dataset.id, other: sel.value });
        note.textContent = 'Linked: ' + row.dataset.name + ' and ' + sel.options[sel.selectedIndex].text + ' are one person now.';
      } else if (ev.target.closest('[data-unlink]')) {
        await api('/api/admin/unlink', { id: ev.target.closest('[data-unlink]').dataset.unlink });
        note.textContent = 'Unlinked.';
      } else if (ev.target.closest('[data-color]')) {
        await api('/api/admin/person', { id: row.dataset.id, color: row.querySelector('input.color').value });
        note.textContent = 'Colour saved.';
      } else if (ev.target.closest('[data-forget]')) {
        if (!window.confirm('Forget ' + row.dataset.name + ' completely, for every character: feelings, facts and memories?')) return;
        await api('/api/admin/person', { id: row.dataset.id, forget: true });
        note.textContent = 'Forgotten.';
      } else return;
      await load();
      renderPlayers(true);
      renderRelationships(true);
    } catch (e) { note.textContent = e.message; }
  });

  $('bot').onsubmit = async (ev) => {
    ev.preventDefault();
    const policy = {};
    for (const el of document.querySelectorAll('[data-perm]')) policy[el.dataset.perm] = el.checked;
    try {
      await api('/api/admin/bot', { enabled: $('b_enabled').checked, model: $('b_model').value,
        effort: $('b_effort').value, cooldown: $('b_cooldown').value, perHour: $('b_perHour').value,
        perDay: $('b_perDay').value, listen: $('b_listen').value, romance: $('b_romance').checked, pranks: $('b_pranks').checked, summaryHour: Number($('b_summaryHour').value),
        idle: { enabled: $('b_idle').checked, after: $('b_idleAfter').value, perHour: $('b_idlePerHour').value }, policy });
      $('botNote').textContent = 'Saved.';
    } catch (e) { $('botNote').textContent = e.message; }
  };
  $('summaryNow').onclick = async () => {
    $('botNote').textContent = 'Writing...';
    try { await api('/api/admin/summary', {}); $('botNote').textContent = 'Posted.'; refreshSoon(); } catch (e) { $('botNote').textContent = e.message; }
  };
  const saveRelay = () => api('/api/admin/relay', { chat: $('r_chat').checked, news: $('r_news').checked }).catch(() => {});
  $('r_chat').onchange = saveRelay; $('r_news').onchange = saveRelay;
  $('announce').onsubmit = async (ev) => {
    ev.preventDefault();
    const text = $('announceText').value.trim();
    if (!text) return;
    $('announceText').value = '';
    await api('/api/admin/announce', { text }).catch((e) => alert(e.message));
    refreshSoon();
  };
  $('restart').onclick = async () => {
    if (!confirm('Restart the game server? Players are disconnected for a few seconds; the world is saved first.')) return;
    try { await api('/api/admin/restart', {}); $('restartNote').textContent = 'Restarting...'; } catch (e) { $('restartNote').textContent = e.message; }
  };
  $('loadChannels').onclick = loadChannels;
  $('discordTest').onclick = async () => {
    try { const r = await api('/api/admin/discord-test', {}); $('discordNote').textContent = r.ok ? 'Posted.' : 'Discord did not take it.'; }
    catch (e) { $('discordNote').textContent = e.message; }
  };
  $('mcpToken').onclick = async () => {
    if (state.mcp.hasToken && !confirm('Make a new token? Clients using the old one stop working.')) return;
    try {
      const r = await api('/api/admin/mcp-token', {});
      state.mcp.hasToken = true;
      $('mcpOut').innerHTML = '<p class="note warn">Copy it now: it is shown only once.</p><code class="copy">' + esc(r.token) + '</code>'
        + '<p class="note muted">Claude Code:</p><code class="copy">claude mcp add --transport http blocky ' + esc(r.url)
        + ' --header "Authorization: Bearer ' + esc(r.token) + '"</code>';
    } catch (e) { $('mcpOut').textContent = e.message; }
  };
  document.addEventListener('click', async (ev) => {
    const m = ev.target.closest('[data-memory]');
    if (m) { await api('/api/admin/forget-memory', { id: Number(m.dataset.memory) }).catch(() => {}); return refreshSoon(); }
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    const [type, player] = [b.dataset.act, b.dataset.player];
    if (type === 'kick' && !confirm('Kick ' + player + '?')) return;
    b.disabled = true;
    try { const r = await api('/api/admin/action', { type, player }); if (!r.ok) alert(r.message); } catch (e) { alert(e.message); }
    b.disabled = false;
  });
}

async function loadChannels() {
  $('discordNote').textContent = 'Loading...';
  try {
    const { channels } = await api('/api/admin/channels');
    const picked = new Set(state.discord.channelIds);
    $('channels').innerHTML = channels.length ? channels.map((c) => '<label class="check"><input type="checkbox" data-chan="' + esc(c.id) + '"'
      + (picked.has(c.id) ? ' checked' : '') + '> ' + esc(c.server) + ' #' + esc(c.name) + '</label>').join('')
      + '<button id="saveChannels">Use these channels</button>'
      : '<p class="muted">The bot sees no text channels. Invite it to your Discord server first (docs/deploy.md).</p>';
    $('discordNote').textContent = '';
    if ($('saveChannels')) $('saveChannels').onclick = async () => {
      const ids = [...document.querySelectorAll('[data-chan]')].filter((el) => el.checked).map((el) => el.dataset.chan);
      try { const r = await api('/api/admin/channels', { ids }); state.discord.channelIds = r.channelIds; $('discordNote').textContent = 'Saved.'; refreshSoon(); }
      catch (e) { $('discordNote').textContent = e.message; }
    };
  } catch (e) { $('discordNote').textContent = e.message; }
}

function refresh() {
  const st = state;
  const me = st.characters.find((c) => c.id === picked) || st.characters[0];
  if (me) $('moodLine').textContent = 'Mood: ' + me.mood.label + (me.mood.reason ? ' (' + me.mood.reason + ')' : '')
    + (me.project ? ' · Project: ' + me.project.title + ' at ' + me.project.site.x + ', ' + me.project.site.y + ', ' + me.project.site.z
      + ' (' + me.project.done + ' of ' + me.project.steps.length + ' steps)' : me.goal ? ' · Working on: ' + me.goal : '');
  const kinds = { answered: 'ok', quiet: 'muted', ignored: 'warn', limited: 'warn', error: 'bad', 'own turn': 'muted', prank: 'warn' };
  $('activity').innerHTML = (st.activity || []).length ? st.activity.map((e) => '<tr><td class="muted">' + clock(e.at) + '</td><td class="'
    + (kinds[e.kind] || '') + '">' + esc(e.kind) + '</td><td>' + esc(e.character || '') + '</td><td>' + esc(e.who || '') + '</td><td>'
    + esc(e.text) + '</td></tr>').join('') : '<tr><td colspan="5" class="muted">Nothing yet.</td></tr>';
  const ago = agoOf;
  renderRelationships(false);
  renderPlayers(false);
  const nameOf = (id) => { const p = st.people.find((x) => x.id === id || (x.aliases || []).some((a) => a.id === id)); return p ? p.name : ''; };
  const mems = st.memories.filter((m) => !me || m.character === me.id);
  $('memories').innerHTML = mems.length ? mems.map((m) => '<tr><td class="muted">' + ago(m.at) + '</td><td>'
    + esc(m.about ? nameOf(m.about) : 'itself') + '</td><td>' + (m.secret ? '<span class="warn">secret</span> ' : '') + esc(m.text) + '</td><td>' + m.weight + '</td>'
    + '<td><button class="quiet" data-memory="' + m.id + '">Forget</button></td></tr>').join('')
    : '<tr><td colspan="5" class="muted">No memories yet.</td></tr>';
  const p = st.server.process;
  const yes = (v, t, f) => '<span class="' + (v ? 'ok' : 'bad') + '">' + (v ? t : f) + '</span>';
  const missing = Object.values(st.missing).flat();
  $('status').innerHTML = [
    ['Join at', '<b>' + esc(st.server.address) + '</b>'],
    ['Map', '<a href="' + esc(st.maps.url) + '" target="_blank" rel="noopener">' + esc(st.maps.url) + '</a> <span class="muted">(public)</span>'],
    ['Game', yes(st.server.connected, 'running', p && p.running ? 'starting...' : 'down')
      + (st.server.timeOfDay !== null ? ' <span class="muted">· ' + st.server.timeOfDay + 'h</span>' : '')],
    ['Process', p ? (p.running ? 'pid ' + p.pid + ', up since ' + clock(p.startedAt) : 'stopped' + (p.lastExit ? ' (exit ' + esc(p.lastExit.signal || p.lastExit.code) + ')' : '')) + (p.crashes ? ' <span class="warn">· ' + p.crashes + ' crashes</span>' : '') : 'not managed here'],
    ['Bot', yes(st.bot.ready, esc(st.bot.name) + ' on ' + esc(st.bot.model), 'no ANTHROPIC_API_KEY') + (st.bot.enabled ? '' : ' <span class="warn">(switched off)</span>')],
    ['Items', st.server.items ? st.server.items + ' known' : '<span class="muted">waiting for the game</span>'],
    ...(missing.length ? [['Not set', '<span class="warn">' + missing.map(esc).join(', ') + '</span>']] : []),
  ].map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('');
  $('players').innerHTML = st.players.length ? st.players.map((pl) => '<tr><td>' + esc(pl.name) + (pl.privs.includes('server') ? ' <span class="warn">admin</span>' : '')
    + '</td><td class="muted">' + (pl.pos ? pl.pos.x + ', ' + pl.pos.y + ', ' + pl.pos.z : '') + '</td><td>' + pl.hp + '</td><td class="row">'
    + '<button class="quiet" data-act="heal" data-player="' + esc(pl.name) + '">Heal</button>'
    + '<button class="danger" data-act="kick" data-player="' + esc(pl.name) + '">Kick</button></td></tr>').join('')
    : '<tr><td colspan="4" class="muted">Nobody online.</td></tr>';
  const box = $('chat');
  const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = st.chat.length ? st.chat.map((c) => '<div class="' + esc(c.source) + '"><span class="src">' + clock(c.at) + ' ' + esc(c.source) + '</span>'
    + (c.name === '*' ? '<i class="muted">' + esc(c.text) + '</i>' : '<b>' + esc(c.name) + '</b>: ' + esc(c.text)) + '</div>').join('')
    : '<div class="muted">No chat yet.</div>';
  if (atEnd) box.scrollTop = box.scrollHeight;
  $('discord').innerHTML = [
    ['Mode', st.discord.mode ? esc(st.discord.mode) : '<span class="warn">off</span>'],
    ['Listening', st.discord.mode === 'bot' ? yes(st.discord.listening, 'yes', 'connecting (needs the Message Content intent)') : '<span class="muted">bot only</span>'],
    ...(st.discord.invite ? [['Invite', '<a href="' + esc(st.discord.invite) + '" target="_blank" rel="noopener">Add the bot to a Discord server</a>']] : []),
    ['Channels', st.discord.channelIds.length ? st.discord.channelIds.map(esc).join(', ') : '<span class="muted">none</span>'],
    ...(st.discord.problem ? [['Setup', '<span class="warn">' + esc(st.discord.problem) + '</span>']] : []),
  ].map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('');
  $('usage').innerHTML = st.usage.length ? st.usage.map((u) => '<tr><td>' + esc(u.day) + '</td><td>' + u.calls + '</td><td>'
    + u.input.toLocaleString() + '</td><td>' + u.output.toLocaleString() + '</td></tr>').join('')
    : '<tr><td colspan="4" class="muted">No calls yet.</td></tr>';
  const log = $('log');
  const logEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.textContent = st.log.join('\\n') || '(nothing yet)';
  if (logEnd) log.scrollTop = log.scrollHeight;
}

let timer = null;
function refreshSoon() { clearTimeout(timer); timer = setTimeout(tick, 300); }
async function tick() {
  clearTimeout(timer);
  if (document.visibilityState === 'visible' && built) await load();
  timer = setTimeout(tick, 4000);
}
load().then(() => { timer = setTimeout(tick, 4000); });
</script></body></html>`;
