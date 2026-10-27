// The bot: the sidecar's HTTP server, then the Discord bot. On Fly it runs under server/launcher.mjs, which runs
// Luanti beside it and can restart the bot alone (SUPERVISED: Luanti's state and restarts go over IPC). Run on its
// own (node server/index.mjs) it starts Luanti itself, as before. Settings from the environment (server/config.mjs,
// docs/deploy.md), the database and the world on the Fly volume.

import { randomBytes } from 'node:crypto';
import { loadConfig } from './config.mjs';
import { openDb } from './db.mjs';
import { makeApp } from './app.mjs';
import { createLuanti } from './luanti.mjs';

const config = loadConfig();
for (const [feature, names] of Object.entries(config.missing)) {
  if (names.length) console.warn(`Not set: ${names.join(', ')}. ${feature === 'bot' ? 'The bot' : 'Admin sign-in'} is off until they are.`);
}
if (!config.adminIds.length) console.warn('ADMIN_DISCORD_ID is not set: nobody can use /admin yet.');
const db = openDb(config.dbPath);
// A new key each start: only this process and the Luanti it starts know it.
const bridgeKey = process.env.BRIDGE_KEY || randomBytes(24).toString('base64url');
// Under the launcher: Luanti is the launcher's; its state comes in every 2 seconds, a restart goes out.
function supervisedLuanti() {
  let last = { status: null, log: [] };
  process.on('message', (m) => { if (m?.type === 'luanti-status') last = m; });
  return {
    status: () => last.status,
    log: (n = 100) => last.log.slice(-n),
    restart: async () => { process.send?.({ type: 'luanti-restart' }); },
    start: async () => {},
    stop: async () => {},
  };
}
const supervised = process.env.SUPERVISED === '1';
const luanti = supervised ? supervisedLuanti() : config.luantiManaged ? createLuanti({ config, bridgeKey }) : null;
const server = makeApp({ config, db, bridgeKey, luanti, daily: true });

server.listen(config.port, '0.0.0.0', async () => {
  console.log(`Sidecar on :${config.port}, ${config.publicUrl}/admin`);
  if (!luanti) console.log(`LUANTI_MANAGED=false: point a Luanti at it with ai_bot.bridge_key = ${bridgeKey}`);
  if (!supervised) await luanti?.start();
  server.discord.start();
  console.log(server.discord.mode ? `Discord: ${server.discord.mode}.` : `No Discord: ${server.discord.problem}`);
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  console.log(supervised ? 'Stopping the bot (the game keeps running).' : 'Stopping: saving the world.');
  server.discord.stop();
  if (!supervised) await luanti?.stop();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
