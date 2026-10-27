// The machine's first process: runs the Luanti server, and the bot (server/index.mjs) beside it as a child it can
// restart on its own, so a change to the bot goes live without restarting the game or disconnecting anyone (owner,
// 2026-10-27: "can we maintain continuos delivery just for the bot code?"). The deploy job puts new bot code in place
// with server/hotdeploy.mjs and sends SIGUSR2; this restarts the bot from it. A new image (a full deploy) restarts all.
//
// The bot's code: a hot release under /data/app (CURRENT, a symlink to a release) when one was made on top of this
// very image; else the image's own /app. A hot release that keeps crashing is rolled back to the one before it, or
// the image. Luanti's state (running, its log) goes to the bot every 2 seconds over IPC, and the bot can ask it to
// restart Luanti the same way.

import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, rmSync, readlinkSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { createLuanti } from './luanti.mjs';

const IMAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig();
const APP = join(config.dataDir, 'app');
const CURRENT = join(APP, 'current');
const PREVIOUS = join(APP, 'previous');
const IMAGE_SHA = process.env.GIT_SHA || 'unknown';
const read = (f) => { try { return readFileSync(f, 'utf8').trim(); } catch { return ''; } };

// A hot release counts only if it was made on top of this image; a newer image (a full deploy) replaces it.
function codeDir() {
  const base = read(join(APP, 'base-image'));
  if (existsSync(join(CURRENT, 'server', 'index.mjs')) && base === IMAGE_SHA) return CURRENT;
  if (existsSync(CURRENT) && base !== IMAGE_SHA) {
    console.log(`A new image (${IMAGE_SHA.slice(0, 7)}): the bot runs the image's code, not the old hot release.`);
    for (const f of [CURRENT, PREVIOUS, join(APP, 'current-sha')]) rmSync(f, { force: true, recursive: false });
  }
  return IMAGE_DIR;
}

const bridgeKey = randomBytes(24).toString('base64url');
const luanti = config.luantiManaged ? createLuanti({ config, bridgeKey }) : null;
import { mkdirSync } from 'node:fs';
mkdirSync(APP, { recursive: true });
writeFileSync(join(config.dataDir, 'launcher.pid'), String(process.pid));
// For server/hotdeploy.mjs, which runs over SSH without this process's environment.
writeFileSync(join(APP, 'image-sha'), IMAGE_SHA);

let bot = null;
let stopping = false;
let starts = [];

function startBot() {
  const dir = codeDir();
  const sha = dir === CURRENT ? read(join(APP, 'current-sha')) || IMAGE_SHA : IMAGE_SHA;
  console.log(`Starting the bot from ${dir === CURRENT ? `hot release ${sha.slice(0, 7)}` : 'the image'}.`);
  starts = [...starts.filter((t) => Date.now() - t < 60_000), Date.now()];
  bot = fork(join(dir, 'server', 'index.mjs'), [], {
    cwd: dir,
    execArgv: ['--disable-warning=ExperimentalWarning'],
    env: { ...process.env, LUANTI_MANAGED: 'false', SUPERVISED: '1', BRIDGE_KEY: bridgeKey, BOT_SHA: sha, IMAGE_DIR },
  });
  bot.on('message', (m) => {
    if (m?.type === 'luanti-restart') luanti?.restart().catch((err) => console.error('Luanti restart failed:', err));
  });
  bot.on('exit', (code, signal) => {
    bot = null;
    if (stopping) return;
    // Crashing over and over right after starting: go back to the code before (or the image's).
    if (starts.length >= 3 && dir === CURRENT) {
      console.error('The new bot code keeps crashing: rolling back.');
      try {
        const prev = existsSync(PREVIOUS) ? readlinkSync(PREVIOUS) : null;
        rmSync(CURRENT, { force: true });
        if (prev) {
          symlinkSync(prev, CURRENT);
          writeFileSync(join(APP, 'current-sha'), prev.split('/').pop());
          rmSync(PREVIOUS, { force: true });
        }
        starts = [];
      } catch (err) { console.error('rollback failed:', err.message); }
    }
    console.log(`The bot stopped (${signal ?? code}); starting it again.`);
    setTimeout(startBot, signal === 'SIGTERM' ? 200 : Math.min(30_000, 1000 * starts.length));
  });
}

// Luanti's state for the bot's admin page, every 2 seconds.
setInterval(() => {
  if (bot?.connected && luanti) bot.send({ type: 'luanti-status', status: luanti.status(), log: luanti.log(120) });
}, 2000).unref();

// SIGUSR2: new bot code is in place; restart the bot only.
process.on('SIGUSR2', () => {
  console.log('New bot code: restarting the bot.');
  starts = [];
  if (bot) bot.kill('SIGTERM'); else startBot();
});

async function stop() {
  if (stopping) return;
  stopping = true;
  console.log('Stopping: the bot, then Luanti (saving the world).');
  bot?.kill('SIGTERM');
  await luanti?.stop();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

await luanti?.start();
startBot();
