// Runs the Luanti server as a child of this process: one machine, one supervisor, so the game, the bot and the
// admin page come up and go down together. Writes the server's config each start (luanti/minetest.conf from the
// repository, then what this file must set), restarts the server when it falls over, and keeps its last lines
// of log for /admin. A stop (Fly's SIGTERM, or Restart on /admin) asks it to save and quit first.

import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const LOG_KEEP = 300;
// More crashes than this inside CRASH_WINDOW and it stays down until an admin restarts it.
const CRASH_MAX = 5;
const CRASH_WINDOW = 5 * 60_000;

/**
 * The lines this server adds to the repository's minetest.conf. A later line wins in Luanti's config, so
 * these come last.
 */
export function managedConfig({ config, bindAddress, bridgeKey }) {
  const lines = {
    server_name: config.serverName,
    server_description: config.serverDescription,
    port: config.gamePort,
    // An empty bind address listens everywhere (local runs, where fly-global-services does not exist).
    bind_address: bindAddress,
    ipv6_server: 'false',
    'secure.http_mods': 'ai_bot',
    // Luanti sends its HTTP from bind_address (CURLOPT_INTERFACE, src/httpfetch.cpp), and from there 127.0.0.1
    // cannot be reached: the mod calls the sidecar at the bound address instead.
    'ai_bot.bridge_url': `http://${bindAddress || '127.0.0.1'}:${config.port}/bridge/sync`,
    'ai_bot.bridge_key': bridgeKey,
  };
  if (config.gameAdmin) lines.name = config.gameAdmin;
  if (config.gamePassword) lines.default_password = config.gamePassword;
  return Object.entries(lines).map(([k, v]) => `${k} = ${String(v).replace(/[\r\n]+/g, ' ')}`).join('\n');
}

/** fly-global-services' IPv4 address, or '' where it does not resolve. */
export async function resolveBind(host) {
  if (!host) return '';
  try {
    return (await lookup(host, { family: 4 })).address;
  } catch {
    return '';
  }
}

export function createLuanti({ config, bridgeKey, baseConfigPath = new URL('../luanti/minetest.conf', import.meta.url),
  spawnImpl = spawn, now = () => Date.now(), log = console }) {
  let child = null;
  let wanted = false;
  let startedAt = 0;
  let lastExit = null;
  let crashes = [];
  let restartTimer = null;
  let bindAddress = '';
  const lines = [];

  function keep(chunk) {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      lines.push(line);
      log.log(`[luanti] ${line}`);
    }
    if (lines.length > LOG_KEEP) lines.splice(0, lines.length - LOG_KEEP);
  }

  async function launch() {
    const confPath = join(config.dataDir, 'minetest.conf');
    const worldPath = join(config.dataDir, 'world');
    await mkdir(config.dataDir, { recursive: true });
    bindAddress = await resolveBind(config.bindHost);
    let base = '';
    try { base = await readFile(baseConfigPath, 'utf8'); } catch { /* no repository config: managed lines only */ }
    await writeFile(confPath, `${base.trimEnd()}\n\n# Written by server/luanti.mjs at start: edit luanti/minetest.conf instead.\n`
      + `${managedConfig({ config, bindAddress, bridgeKey })}\n`);
    const args = ['--config', confPath, '--world', worldPath, '--gameid', config.gameId, '--logfile', ''];
    log.log(`Starting Luanti on UDP ${bindAddress || '*'}:${config.gamePort}, world ${worldPath}`);
    child = spawnImpl(config.luantiBin, args, { cwd: config.dataDir, stdio: ['ignore', 'pipe', 'pipe'] });
    startedAt = now();
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', (err) => keep(`could not start: ${err.message}`));
    child.on('exit', (code, signal) => {
      child = null;
      lastExit = { code, signal, at: now() };
      if (!wanted) return;
      crashes = [...crashes.filter((t) => now() - t < CRASH_WINDOW), now()];
      if (crashes.length > CRASH_MAX) {
        keep(`exited ${crashes.length} times in five minutes: staying down until restarted from /admin.`);
        wanted = false;
        return;
      }
      const wait = 2000 * crashes.length;
      keep(`exited (${signal ?? code}); starting again in ${wait / 1000}s.`);
      restartTimer = setTimeout(() => { if (wanted && !child) launch().catch((e) => keep(e.message)); }, wait);
    });
  }

  /** Ask the server to stop, waiting up to `ms` for it to save the world. */
  function halt(ms = 25_000) {
    clearTimeout(restartTimer);
    if (!child) return Promise.resolve();
    const c = child;
    return new Promise((resolve) => {
      const force = setTimeout(() => { c.kill('SIGKILL'); }, ms);
      c.once('exit', () => { clearTimeout(force); resolve(); });
      c.kill('SIGTERM');
    });
  }

  return {
    async start() {
      wanted = true;
      crashes = [];
      if (!child) await launch();
    },
    async stop() {
      wanted = false;
      await halt();
    },
    async restart() {
      wanted = false;
      await halt();
      wanted = true;
      crashes = [];
      await launch();
    },
    status() {
      return { running: child !== null, pid: child?.pid ?? null, startedAt: child ? startedAt : null, lastExit,
        crashes: crashes.length, bindAddress: bindAddress || '*', port: config.gamePort };
    },
    log: (n = 100) => lines.slice(-n),
  };
}
