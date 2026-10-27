// The admin page, served at /admin, after RubenTipparach/rubens-solitare-collection's: one self-contained
// page. Sign in with Discord (back to this page with the link in the address's fragment), then the server's
// state, who is online with a few buttons each, the chat with a box to announce, the bot's settings, Discord's
// channels, the MCP token, what the LLM has cost, and the game's log. It talks to /api/admin with the link as a
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
  @media (max-width: 560px) { .two, .three { grid-template-columns: 1fr; } }
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
<div class="grid">
  <section><h2>Server</h2><dl class="status" id="status"></dl>
    <div class="row" style="margin-top:12px"><button class="quiet" id="restart">Restart Luanti</button><span id="restartNote" class="muted note"></span></div></section>
  <section><h2>Online</h2><div class="scroll"><table><thead><tr><th>Player</th><th>Position</th><th>HP</th><th></th></tr></thead>
    <tbody id="players"></tbody></table></div></section>
</div>
<section style="margin-top:14px"><h2>Chat</h2><div class="chat" id="chat"></div>
  <form class="row" id="announce"><input id="announceText" maxlength="400" placeholder="Say something to everyone, as the server">
  <button>Send</button></form></section>
<div class="grid">
  <section><h2>The bot</h2><form id="bot">
    <label class="check"><input type="checkbox" id="b_enabled"> Answers in chat</label>
    <div class="two"><label class="field">Name (players say @name)<input id="b_name" maxlength="20"></label>
    <label class="field">Effort<select id="b_effort">\${state.efforts.map((e) => '<option>' + e + '</option>').join('')}</select></label></div>
    <label class="field">Model<select id="b_model">\${[...new Set([...state.models, s.model])].map((m) => '<option>' + esc(m) + '</option>').join('')}</select></label>
    <div class="two"><label class="field">Listens to<select id="b_listen"><option value="mentions">Only messages that say its name</option>
      <option value="all">Every chat message (it joins in when it has something to say)</option></select></label>
    <label class="field">Daily summary at (UTC hour, -1 = off)<input id="b_summaryHour" type="number" min="-1" max="23"></label></div>
    <div class="three"><label class="field">Cooldown (s)<input id="b_cooldown" type="number" min="0"></label>
    <label class="field">Per player / hour<input id="b_perHour" type="number" min="0"></label>
    <label class="field">Calls / day (0 = no limit)<input id="b_perDay" type="number" min="0"></label></div>
    <label class="check"><input type="checkbox" id="b_idle"> Does things on its own when nobody asks (builds small things, walks, chats)</label>
    <div class="two"><label class="field">After a quiet spell of (seconds)<input id="b_idleAfter" type="number" min="15"></label>
    <label class="field">Own turns per hour, at most<input id="b_idlePerHour" type="number" min="0"></label></div>
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
<section style="margin-top:14px"><h2>Character</h2>
  <p class="muted note" id="moodLine"></p>
  <form id="character">
    <label class="field">Backstory<textarea id="c_backstory" maxlength="3000"></textarea></label>
    <div class="two"><label class="field">Personality<textarea id="c_personality" maxlength="3000"></textarea></label>
    <label class="field">How it talks<textarea id="c_speech" maxlength="3000"></textarea></label></div>
    <label class="field">What it wants in life<textarea id="c_goals" maxlength="3000"></textarea></label>
    <label class="field">Working on now (it changes this itself)<input id="c_goal" maxlength="200"></label>
    <div class="row"><button>Save character</button><button type="button" class="quiet" id="resetMood">Calm its mood</button>
      <span id="charNote" class="note muted"></span></div>
  </form></section>
<section style="margin-top:14px"><h2>People it knows</h2>
  <p class="muted note">Affinity runs from -100 (hostile) to 100 (best friend), trust from 0 to 100. The bot moves them a little at a time; you can set them here.
  Players join their game and Discord selves by typing <code>!link</code> in game.</p>
  <div class="scroll"><table><thead><tr><th>Person</th><th>Feels</th><th>Affinity</th><th>Trust</th><th>Nickname</th><th>Talks</th><th>Last seen</th><th></th></tr></thead>
  <tbody id="people"></tbody></table></div></section>
<section style="margin-top:14px"><h2>Memories</h2><div class="scroll"><table><thead><tr><th>When</th><th>About</th><th>Memory</th><th>Weight</th><th></th></tr></thead>
  <tbody id="memories"></tbody></table></div></section>
<section style="margin-top:14px"><h2>Luanti log</h2><pre id="log"></pre></section>\`;
  const ch = state.character;
  $('c_backstory').value = ch.backstory; $('c_personality').value = ch.personality; $('c_speech').value = ch.speech;
  $('c_goals').value = ch.goals; $('c_goal').value = ch.goal || '';
  $('character').onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      await api('/api/admin/character', { backstory: $('c_backstory').value, personality: $('c_personality').value,
        speech: $('c_speech').value, goals: $('c_goals').value, goal: $('c_goal').value });
      $('charNote').textContent = 'Saved.';
    } catch (e) { $('charNote').textContent = e.message; }
  };
  $('resetMood').onclick = async () => { await api('/api/admin/character', { resetMood: true }).catch(() => {}); refreshSoon(); };
  document.addEventListener('change', async (ev) => {
    const link = ev.target.closest('[data-link]');
    if (link && link.value) {
      const other = link.options[link.selectedIndex].text;
      if (!confirm('Make ' + other + ' the same person as this row? The feelings of this row stay; talks, facts and memories join.')) { link.value = ''; return; }
      try { await api('/api/admin/link', { keep: link.dataset.link, other: link.value }); } catch (e) { alert(e.message); }
      return refreshSoon();
    }
    const el = ev.target.closest('[data-person]');
    if (!el) return;
    try { await api('/api/admin/person', { id: el.dataset.person, [el.dataset.field]: el.value }); refreshSoon(); } catch (e) { alert(e.message); }
  });

  $('b_enabled').checked = s.enabled; $('b_name').value = s.name; $('b_model').value = s.model; $('b_effort').value = s.effort;
  $('b_cooldown').value = s.cooldown; $('b_perHour').value = s.perHour; $('b_perDay').value = s.perDay;
  $('b_listen').value = s.listen; $('b_summaryHour').value = s.summaryHour;
  $('b_idle').checked = s.idle.enabled; $('b_idleAfter').value = s.idle.after; $('b_idlePerHour').value = s.idle.perHour;
  const perms = [...new Map(state.policyTools.map((t) => [t.permission, t])).keys()];
  const label = { give: 'Items for themselves', teleport: 'Teleporting themselves', heal: 'Healing themselves', time: 'Changing the time of day', build: 'Building (placing blocks)' };
  $('policy').innerHTML = perms.map((p) => '<label class="check"><input type="checkbox" data-perm="' + p + '"' + (s.policy[p] ? ' checked' : '')
    + '> ' + esc(label[p] || p) + '</label>').join('');
  $('r_chat').checked = state.relay.chat; $('r_news').checked = state.relay.news;

  $('bot').onsubmit = async (ev) => {
    ev.preventDefault();
    const policy = {};
    for (const el of document.querySelectorAll('[data-perm]')) policy[el.dataset.perm] = el.checked;
    try {
      await api('/api/admin/bot', { enabled: $('b_enabled').checked, name: $('b_name').value, model: $('b_model').value,
        effort: $('b_effort').value, cooldown: $('b_cooldown').value, perHour: $('b_perHour').value,
        perDay: $('b_perDay').value, listen: $('b_listen').value, summaryHour: Number($('b_summaryHour').value),
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
    const f = ev.target.closest('[data-forget]');
    if (f) {
      if (!confirm('Forget ' + f.dataset.name + ' completely: feelings, facts and memories?')) return;
      await api('/api/admin/person', { id: f.dataset.forget, forget: true }).catch((e) => alert(e.message));
      return refreshSoon();
    }
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
  const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest('#people');
  $('moodLine').textContent = 'Mood: ' + st.character.mood.label + (st.character.mood.reason ? ' (' + st.character.mood.reason + ')' : '')
    + (st.character.goal ? ' · Working on: ' + st.character.goal : '');
  const feels = (a) => a <= -60 ? 'hostile' : a <= -25 ? 'dislike' : a < -5 ? 'wary' : a < 15 ? 'neutral' : a < 35 ? 'friendly' : a < 60 ? 'fond' : a < 85 ? 'close friend' : 'best friend';
  const where = (p) => [p, ...(p.aliases || [])].map((x) => (x.id.startsWith('discord:') ? 'Discord: ' : 'Game: ') + esc(x.name)).join('<br>');
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
  if (!typing) $('people').innerHTML = st.people.length ? st.people.map((p) => '<tr><td>' + where(p)
    + (p.facts.length ? '<div class="note muted">' + p.facts.map(esc).join(' · ') + '</div>' : '') + '</td><td>' + feels(p.affinity) + '</td>'
    + '<td><input type="number" min="-100" max="100" style="width:80px" data-person="' + esc(p.id) + '" data-field="affinity" value="' + p.affinity + '"></td>'
    + '<td><input type="number" min="0" max="100" style="width:72px" data-person="' + esc(p.id) + '" data-field="trust" value="' + p.trust + '"></td>'
    + '<td><input style="width:110px" data-person="' + esc(p.id) + '" data-field="nickname" value="' + esc(p.nickname || '') + '"></td>'
    + '<td>' + p.talks + '</td><td class="muted">' + ago(p.last_at) + '</td>'
    + '<td class="row"><select data-link="' + esc(p.id) + '" style="width:auto"><option value="">Link with...</option>'
    + st.people.filter((o) => o.id !== p.id).map((o) => '<option value="' + esc(o.id) + '">' + (o.id.startsWith('discord:') ? 'Discord: ' : 'Game: ') + esc(o.name) + '</option>').join('')
    + '</select><button class="danger" data-forget="' + esc(p.id) + '" data-name="' + esc(p.name) + '">Forget</button></td></tr>').join('')
    : '<tr><td colspan="8" class="muted">Nobody yet: it meets people as they chat.</td></tr>';
  const nameOf = (id) => { const p = st.people.find((x) => x.id === id || (x.aliases || []).some((a) => a.id === id)); return p ? p.name : ''; };
  $('memories').innerHTML = st.memories.length ? st.memories.map((m) => '<tr><td class="muted">' + ago(m.at) + '</td><td>'
    + esc(m.about ? nameOf(m.about) : 'itself') + '</td><td>' + (m.secret ? '<span class="warn">secret</span> ' : '') + esc(m.text) + '</td><td>' + m.weight + '</td>'
    + '<td><button class="quiet" data-memory="' + m.id + '">Forget</button></td></tr>').join('')
    : '<tr><td colspan="5" class="muted">No memories yet.</td></tr>';
  const p = st.server.process;
  const yes = (v, t, f) => '<span class="' + (v ? 'ok' : 'bad') + '">' + (v ? t : f) + '</span>';
  const missing = Object.values(st.missing).flat();
  $('status').innerHTML = [
    ['Join at', '<b>' + esc(st.server.address) + '</b>'],
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
