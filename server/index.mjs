// Starts everything on the one machine: the sidecar's HTTP server, then Luanti as its child, then the
// Discord bot. Settings from the environment (server/config.mjs, docs/deploy.md), the database and the world
// on the Fly volume.
//   node server/index.mjs

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
const luanti = config.luantiManaged ? createLuanti({ config, bridgeKey }) : null;
const server = makeApp({ config, db, bridgeKey, luanti });

server.listen(config.port, '0.0.0.0', async () => {
  console.log(`Sidecar on :${config.port}, ${config.publicUrl}/admin`);
  if (!luanti) console.log(`LUANTI_MANAGED=false: point a Luanti at it with ai_bot.bridge_key = ${bridgeKey}`);
  await luanti?.start();
  server.discord.start();
  console.log(server.discord.mode ? `Discord: ${server.discord.mode}.` : `No Discord: ${server.discord.problem}`);
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  console.log('Stopping: saving the world.');
  server.discord.stop();
  await luanti?.stop();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
