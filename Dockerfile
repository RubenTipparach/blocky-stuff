# The game server and its sidecar for Fly.io (docs/deploy.md): the official Luanti server image, with Minetest
# Game and the ai_bot mod, and Node for the sidecar (server/), which starts Luanti and keeps it running. One
# process tree on one machine: the world and the sidecar's database share the /data volume.
FROM ghcr.io/luanti-org/luanti:5.17.0

USER root
# Node 22.13 or later for node:sqlite; su-exec to drop to the image's minetest user after fixing the volume.
RUN apk add --no-cache nodejs npm su-exec

# Minetest Game, pinned: the game the world is made with. Its id is the folder name (LUANTI_GAME).
ARG GAME_REPO=https://github.com/luanti-org/minetest_game.git
ARG GAME_COMMIT=f6b2792eac2afbe81cf640f9d245d41fa87b0f2c
RUN apk add --no-cache --virtual .fetch git \
  && git clone --filter=blob:none "$GAME_REPO" /usr/local/share/luanti/games/minetest_game \
  && git -C /usr/local/share/luanti/games/minetest_game checkout --quiet "$GAME_COMMIT" \
  && rm -rf /usr/local/share/luanti/games/minetest_game/.git \
  && apk del .fetch
# Inside the game, so it loads in every world without enabling it in world.mt.
COPY mods/ai_bot /usr/local/share/luanti/games/minetest_game/mods/ai_bot

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY luanti ./luanti

ENV NODE_ENV=production PORT=8080 DATA_DIR=/data LUANTI_BIN=/usr/local/bin/luantiserver
EXPOSE 8080/tcp 30000/udp
# A fresh Fly volume belongs to root: hand it to minetest, then run as minetest.
ENTRYPOINT []
CMD ["sh", "-c", "mkdir -p \"$DATA_DIR\" && chown -R minetest:minetest \"$DATA_DIR\" && exec su-exec minetest:minetest node --disable-warning=ExperimentalWarning server/index.mjs"]
