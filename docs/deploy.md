# Deploying and setting up

Every push deploys from GitHub Actions (`.github/workflows/deploy.yml`) to the Fly app **blocky-stuff**. The
job builds the image, boots it and waits for the game's mod to reach the sidecar, then stages the secrets below
onto Fly, makes sure the volume and the game's IPv4 exist, and deploys. No `flyctl` needed on your machine.

- Admin page: https://blocky-stuff.fly.dev/admin
- Players join at the app's **dedicated IPv4**, port **30000**. The deploy job prints it ("Players join at …"),
  and the admin page shows it under Server, Join at.

## Secrets (GitHub, Settings, Secrets and variables, Actions)

Each is optional except `FLY_API_TOKEN`; a feature stays off until its secret is set.

| Secret | What it does | Where it comes from |
|---|---|---|
| `FLY_API_TOKEN` | Lets the job deploy | `fly tokens create org personal` (or the Fly dashboard, Tokens) |
| `ANTHROPIC_API_KEY` | The bot's brain | console.anthropic.com, API Keys |
| `DISCORD_CLIENT_ID` | Admin sign-in, and the bot's invite link | Discord Developer Portal, your app, OAuth2 |
| `DISCORD_CLIENT_SECRET` | Admin sign-in | Same page, Reset Secret |
| `ADMIN_DISCORD_ID` | Who may use /admin (comma separated) | Sign in on /admin: it tells you your id |
| `DISCORD_BOT_TOKEN` | News and chat both ways with Discord | Developer Portal, your app, Bot, Reset Token |
| `DISCORD_CHANNEL_ID` | The bot's channels, if you would rather not pick them on /admin | Right-click a channel, Copy Channel ID |
| `DISCORD_WEBHOOK_URL` | Posts only, no bot (instead of the bot token) | Channel, Edit, Integrations, Webhooks |
| `GAME_ADMIN` | Your player name: gets every privilege in game | The name you join with |
| `GAME_PASSWORD` | New players must type it to join | Anything |
| `MCP_TOKEN` | A fixed MCP token (otherwise make one on /admin) | Anything long and random |
| `SESSION_SECRET` | Signs admin sign-ins (otherwise the server makes its own) | Anything long and random |

After adding or changing a secret, run the workflow again (Actions, deploy, Run workflow) or push.

## Discord

One Discord application does both the admin sign-in and the bot.

1. **Sign-in redirect.** Developer Portal, your app, **OAuth2**, Redirects, add
   `https://blocky-stuff.fly.dev/auth/discord/callback`, Save.
2. **The bot.** **Bot** page: Reset Token, copy it into the `DISCORD_BOT_TOKEN` secret. On the same page switch on
   **Message Content Intent** (under Privileged Gateway Intents) and save; without it the bot can post but cannot
   read what people type, and the admin page shows "Listening: connecting". Leave Public Bot as you like.
3. **Invite it.** On /admin, Discord, click **Add the bot to a Discord server**, or open
   `https://discord.com/oauth2/authorize?client_id=<DISCORD_CLIENT_ID>&scope=bot&permissions=84992`.
   That asks for View Channels, Send Messages, Embed Links and Read Message History only. Pick your server.
4. **Its channel.** If the channel is private, add the bot (or its role) to it: channel settings, Permissions.
   Then on /admin, Discord, **Pick channels**, tick the channel (one per server if you have several), **Use these
   channels**, then **Test post**.
5. **Relay.** On the same card: "Chat both ways" carries game chat to Discord, Discord messages into the game,
   and the bot's answers to both; "Joins, leaves and server start" posts the news.

People in the channel talk to the bot the same way as in game: `@Blocky …` (a Discord mention of the bot works
too) or `!ai …`. Discord users are never admins to the bot, whatever their name.

## MCP

On /admin, MCP, **Make a token**, and copy the command it shows:

```sh
claude mcp add --transport http blocky https://blocky-stuff.fly.dev/mcp --header "Authorization: Bearer <token>"
```

## Costs

One `shared-cpu-1x` machine with 1 GB, never stopped (Fly cannot wake a machine for UDP), a 3 GB volume and a
dedicated IPv4 (UDP does not work on a shared one). The LLM is billed by Anthropic per call; the admin page shows
the calls and tokens a day, and the bot's daily limit (Calls / day) caps them.

## Local

```sh
npm install
npm test
npm run dev        # the sidecar alone on :8080, without Luanti; /admin works once sign-in secrets are set
```

To run the whole thing, build the image: `docker build -t blocky . && docker run -p 8080:8080 -p 30000:30000/udp -e LUANTI_BIND_HOST= blocky`,
then join `localhost:30000` from Luanti.
