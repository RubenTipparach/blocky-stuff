// The server's settings, all from the environment (Fly.io secrets in production; docs/deploy.md lists each
// one and where it comes from). Read once at start. What an admin may change while the server runs (the
// bot's name, persona, model, what players may ask it to do) lives in the database instead (server/db.mjs),
// with these as the first values.

export function loadConfig(env = process.env) {
  const list = (v) => [...new Set(String(v ?? '').split(/[\s,]+/).filter(Boolean))];
  const config = {
    port: Number(env.PORT ?? 8080),
    // Where the admin page is reached from outside, for Discord's redirect: https://<app>.fly.dev.
    publicUrl: (env.PUBLIC_URL ?? 'http://localhost:8080').replace(/\/$/, ''),
    dataDir: env.DATA_DIR ?? '/data',
    dbPath: env.DB_PATH ?? `${env.DATA_DIR ?? '/data'}/blocky.db`,

    // The Luanti server this process starts and keeps running (server/luanti.mjs).
    luantiBin: env.LUANTI_BIN ?? '/usr/local/bin/luantiserver',
    // Off for local work on the sidecar alone: then nothing is started, and the mod may connect from a
    // Luanti you run yourself.
    luantiManaged: (env.LUANTI_MANAGED ?? 'true') !== 'false',
    gameId: env.LUANTI_GAME ?? 'minetest_game',
    gamePort: Number(env.LUANTI_PORT ?? 30000),
    // Fly delivers UDP only to a socket bound to this name's address (fly.io/docs/networking/udp-and-tcp).
    // Elsewhere the name does not resolve and the server binds everywhere.
    bindHost: env.LUANTI_BIND_HOST ?? 'fly-global-services',
    serverName: env.SERVER_NAME ?? 'Blocky Stuff',
    // What players type in Luanti's Join Game: the app's dedicated IPv4 (Fly carries UDP on IPv4 only, and a
    // client may try the name's IPv6 first). The deploy job sets it once it has the address.
    gameAddress: env.GAME_ADDRESS ?? '',
    serverDescription: env.SERVER_DESCRIPTION ?? 'A Luanti server with an AI you can talk to in chat.',
    // The in-game admin: this player name gets every privilege on first join.
    gameAdmin: env.GAME_ADMIN ?? '',
    // Players need this to join, when set.
    gamePassword: env.GAME_PASSWORD ?? '',

    // The LLM. The key is the only thing the bot needs; the rest are first values for the admin page.
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? '',
    model: env.BOT_MODEL ?? 'claude-opus-5-5',
    effort: env.BOT_EFFORT ?? 'low',
    botName: env.BOT_NAME ?? 'Blocky',

    // Discord sign-in for the admin page.
    discordClientId: env.DISCORD_CLIENT_ID ?? '',
    discordClientSecret: env.DISCORD_CLIENT_SECRET ?? '',
    // Optional: signs admin links. Unset, the server makes its own once and keeps it in its database.
    sessionSecret: env.SESSION_SECRET ?? '',
    // Discord ids allowed on the admin page (/admin), comma separated. The page tells a signed-in visitor
    // their id.
    adminIds: list(env.ADMIN_DISCORD_ID ?? env.ADMIN_DISCORD_IDS ?? ''),
    // The Discord bot: posts server news to its channels and carries chat both ways (server/discord.mjs).
    // Its channels are picked on the admin page, or set here.
    discordBotToken: (env.DISCORD_BOT_TOKEN ?? '').trim(),
    discordChannelIds: list(env.DISCORD_CHANNEL_ID ?? env.DISCORD_CHANNEL_IDS ?? ''),
    // Or one-way posts only, through channel webhooks.
    discordWebhookUrls: list(env.DISCORD_WEBHOOK_URL ?? ''),

    // A fixed MCP token (server/mcp.mjs), for when you would rather keep it in Fly's secrets than make one on
    // the admin page.
    mcpToken: (env.MCP_TOKEN ?? '').trim(),
  };
  // What each feature needs, by its environment name: the server runs without them, the feature off.
  const need = { bot: [['ANTHROPIC_API_KEY', 'anthropicApiKey']], signIn: [['DISCORD_CLIENT_ID', 'discordClientId'],
    ['DISCORD_CLIENT_SECRET', 'discordClientSecret']] };
  config.missing = Object.fromEntries(Object.entries(need)
    .map(([feature, names]) => [feature, names.filter(([, k]) => !config[k]).map(([name]) => name)]));
  return config;
}
