// The bridge to the game. The Lua mod (mods/ai_bot/init.lua) cannot listen for requests, so it calls in:
// once a second it posts what changed (chat, joins, leaves, the players' whereabouts, the results of what it
// was asked to do) to POST /bridge/sync, and the answer carries the actions waiting for it. Everything that
// acts on the world, the bot, the admin page and MCP alike, goes through act(), which resolves once the mod
// reports back.
//
//   sync body:   { players: [{ name, pos: {x,y,z}, hp, privs: [..] }], time, events: [..], results: [..] }
//     events:    { type: 'chat', name, text } | { type: 'join', name } | { type: 'leave', name }
//                | { type: 'start', items: ['default:dirt', ..] }
//     results:   { id, ok, message }
//   answer:      { actions: [{ id, type, ... }] }   (types: ACTIONS below; the mod checks them again)

// What the mod knows how to do, with the fields each takes.
export const ACTIONS = {
  say: ['text', 'to?', 'from?', 'near?'],
  give: ['player', 'item', 'count?'],
  teleport: ['player', 'x', 'y', 'z'],
  time: ['value'],
  place: ['nodes'],
  kick: ['player', 'reason?'],
  heal: ['player'],
  ground: ['columns'],
  scan: ['x1', 'z1', 'w', 'd'],
  farm: ['x1', 'z1', 'x2', 'z2', 'crop?', 'water?'],
  entrance: ['x', 'y', 'z', 'facing?'],
  box: ['item', 'x1', 'y1', 'z1', 'x2', 'y2', 'z2', 'hollow?'],
  clear: ['x1', 'z1', 'x2', 'z2', 'mode', 'y?', 'surface?', 'fill?'],
  harvest: ['x1', 'z1', 'x2', 'z2', 'y', 'player?'],
  walk: ['x', 'y', 'z'],
  follow: ['player'],
  come: ['player'],
  stay: [],
};

// No word from the mod for this long and the game counts as down.
const STALE_MS = 10_000;
const ACT_TIMEOUT_MS = 8_000;

export function createGame({ now = () => Date.now() } = {}) {
  let players = [];
  let bodies = []; // where each character's body stands: { id, x, y, z }
  const actListeners = [];
  let time = null;
  let seenAt = 0;
  let items = [];
  let nextId = 1;
  const queue = [];
  const pending = new Map(); // id -> { resolve, timer }
  const listeners = [];

  function emit(event) {
    for (const fn of listeners) {
      try { fn(event); } catch (err) { console.error('game event handler failed:', err); }
    }
  }

  return {
    get connected() { return seenAt > 0 && now() - seenAt < STALE_MS; },
    get seenAt() { return seenAt; },
    get players() { return players; },
    get bodies() { return bodies; },
    /** Every item the game has. The mod sends them when Luanti starts; a restarted bot gets them back from storage. */
    get items() { return items; },
    set items(list) { if (Array.isArray(list)) items = list.filter((s) => typeof s === 'string'); },
    /** fn(action) for every action sent to the game. */
    onAct(fn) { actListeners.push(fn); },
    get time() { return time; },
    get items() { return items; },
    /** Calls fn with every event the mod reports. */
    onEvent(fn) { listeners.push(fn); },
    /** The mod's call: take in what it sent, answer with what waits for it. */
    sync(body) {
      seenAt = now();
      if (Array.isArray(body?.players)) {
        players = body.players.filter((p) => typeof p?.name === 'string').map((p) => ({
          name: p.name, pos: roundPos(p.pos), hp: Number(p.hp) || 0, privs: Array.isArray(p.privs) ? p.privs : [],
          look: lookOf(p.look),
        }));
      }
      if (typeof body?.time === 'number') time = body.time;
      if (Array.isArray(body?.bodies)) bodies = body.bodies.filter((b) => typeof b?.id === 'string' && Number.isFinite(b.x));
      for (const r of Array.isArray(body?.results) ? body.results : []) {
        const p = pending.get(r?.id);
        if (!p) continue;
        clearTimeout(p.timer);
        pending.delete(r.id);
        p.resolve({ ok: r.ok === true, message: String(r.message ?? '') });
      }
      for (const e of Array.isArray(body?.events) ? body.events : []) {
        if (e?.type === 'start' && Array.isArray(e.items)) items = e.items.filter((s) => typeof s === 'string');
        emit(e);
      }
      return { actions: queue.splice(0, queue.length) };
    },
    /** Ask the mod to do something; resolves with { ok, message } when it reports back, or a timeout. */
    act(action) {
      const problem = checkAction(action);
      if (problem) return Promise.resolve({ ok: false, message: problem });
      if (!this.connected) return Promise.resolve({ ok: false, message: 'The game server is not running.' });
      // Whoever wants to know what is being done to the world (the map, for what to read again).
      for (const fn of actListeners) { try { fn(action); } catch { /* a listener's problem */ } }
      const id = nextId++;
      queue.push({ ...action, id });
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, message: 'The game did not answer in time.' });
        }, ACT_TIMEOUT_MS);
        pending.set(id, { resolve, timer });
      });
    },
    player(name) {
      const want = String(name ?? '').toLowerCase();
      return players.find((p) => p.name.toLowerCase() === want) ?? null;
    },
    /** Item names matching every word of `query`, best (shortest) first. */
    findItems(query, max = 20) {
      const words = String(query ?? '').toLowerCase().split(/[\s_:]+/).filter(Boolean);
      return items.filter((name) => words.every((w) => name.toLowerCase().includes(w)))
        .sort((a, b) => a.length - b.length).slice(0, max);
    },
  };
}

/** Why an action is malformed, or null. */
export function checkAction(action) {
  const fields = ACTIONS[action?.type];
  if (!fields) return `Unknown action ${action?.type}.`;
  for (const f of fields) {
    if (!f.endsWith('?') && (action[f] === undefined || action[f] === null || action[f] === '')) {
      return `${action.type} needs ${f}.`;
    }
  }
  if (action.type === 'place' && (!Array.isArray(action.nodes) || action.nodes.length > 2048)) {
    return 'place takes a list of at most 2048 nodes.';
  }
  if (action.type === 'ground' && (!Array.isArray(action.columns) || action.columns.length > 25)) {
    return 'ground takes a list of at most 25 columns.';
  }
  return null;
}

const roundPos = (p) => (p && typeof p === 'object'
  ? { x: Math.round(Number(p.x) || 0), y: Math.round(Number(p.y) || 0), z: Math.round(Number(p.z) || 0) } : null);
// Where a player looks: { facing (north, north-east...), pitch (degrees up), at: { x, y, z, block, dist } or null }.
const FACINGS = new Set(['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']);
const lookOf = (l) => (l && FACINGS.has(l.facing) ? { facing: l.facing, pitch: Math.round(Number(l.pitch) || 0),
  at: l.at && typeof l.at.block === 'string' ? { ...roundPos(l.at), block: l.at.block.slice(0, 80), dist: Math.round(Number(l.at.dist) || 0) } : null } : null);
