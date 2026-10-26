# blocky-stuff

A [Luanti](https://www.luanti.org/) server on Fly.io with an AI living in it. Players talk to it in chat
(`@Blocky how do I make a furnace?`, `!ai give me some torches`), from the game or from Discord, and it can act on
the world: give items, teleport, heal, set the time, build. An admin page runs the server, and an MCP server lets
Claude Code or Claude Desktop run it too.

```
Players ──UDP 30000──► Luanti 5.17 + Minetest Game ─┐ mods/ai_bot (Lua): chat, joins, actions
                                                    │ POST /bridge/sync once a second (localhost)
Discord ◄──Gateway / REST──►  sidecar (Node, server/) ◄──► Claude API (tool use)
                              ├─ /admin   Discord sign-in, players, chat, bot settings, channels
                              └─ /mcp     the same tools, for MCP clients
```

- **Deploy and set up:** [docs/deploy.md](docs/deploy.md): secrets, Discord bot, invite link, channels, MCP.
- **Admin page:** https://blocky-stuff.fly.dev/admin
- **Join:** the app's dedicated IPv4, port 30000 (shown on the admin page).

## Layout

| Path | What |
|---|---|
| `server/index.mjs` | Starts the sidecar, Luanti (as its child) and the Discord bot |
| `server/luanti.mjs` | Writes Luanti's config, runs and restarts it |
| `server/game.mjs` | The bridge to the mod: players, events, actions |
| `server/bot.mjs` | The chat bot: when it answers, the Claude call, limits |
| `server/tools.mjs` | What the AI may do, and who may ask for what |
| `server/discord.mjs` | Discord posts and the Gateway (messages from the channel) |
| `server/mcp.mjs` | MCP over Streamable HTTP |
| `server/app.mjs`, `server/admin-page.mjs` | HTTP routes and the admin page |
| `mods/ai_bot/` | The Luanti mod |
| `luanti/minetest.conf` | Luanti's settings (edit here; the server adds the rest) |

## Develop

```sh
npm install
npm test
```
