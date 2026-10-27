# To do

Planned work, roughly in order. Each item says what it is, why, and how it would work.

## Sight for the characters

The Luanti server never renders the world (only players' clients do), so the characters cannot take
screenshots. Today they see data only: who is where, the ground at a spot, the item names.

### 1. Read the blocks around them (planned)

- **What:** a `look_at` tool that reads the blocks in an area and hands the model a map: a top-down view (the
  highest block per column) and a few side slices.
- **Why:** they could look at a player's house, notice what is missing, find a cave, and build to fit what is
  there instead of guessing from the ground height.
- **How:** a `look` action in `mods/ai_bot/init.lua` (VoxelManip read of a box, at most 32x16x32), returned as
  text rows with a short legend of block names; a tool in `server/tools.mjs`, open to everyone.
- **Cost:** small; a few hundred tokens per look.

### 2. See screenshots posted in Discord (planned)

- **What:** an image posted in the bot's Discord channel goes to the character answering, as an image.
- **Why:** "Moss, what do you think of my castle?" with a screenshot works; players share builds anyway.
- **How:** `server/discord.mjs` passes image attachments (PNG, JPEG, GIF, WebP, up to 5 MB, at most 2 a message)
  to `server/bot.mjs`, which adds them to the user message as `image` blocks by URL.
- **Cost:** small; roughly an image's worth of tokens each, only when someone posts one.

### 3. Real in-game screenshots (not planned)

- **What:** a second, headless Luanti client on the server that joins as an invisible camera, renders in
  software and sends pictures to the model.
- **Why not now:** needs a bigger Fly machine (2 to 4 GB, more CPU), costs noticeably more each month, and is
  fiddly to keep reliable; 1 and 2 cover most of it.
