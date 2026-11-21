# «Адмирал»: the game page and its online server in one image.
# Northflank: a combined/deployment service built from this Dockerfile, ONE instance (tables live in memory),
# public HTTP port 8080 (WebSocket at /ws goes through the same port), health check GET /healthz.
# Optional: TURN_SECONDS — the time for a decision in a game (60 by default, at least 15).
# VK payments: set VK_APP_ID, VK_APP_SECRET, and VK_PAYMENTS_DB_PATH on a persistent volume.

# 1) the page: tools/build.py puts the sources, the board data, the engine and the ship models into admiral-3d.html
FROM python:3.12-slim AS page
WORKDIR /app
RUN pip install --no-cache-dir pillow==11.3.0
COPY tools/build.py tools/commentator_data.py tools/
COPY src src
COPY assets assets
COPY kenney_pirate-kit_2.1 kenney_pirate-kit_2.1
RUN python tools/build.py

# 2) the server: the page, the files it loads (sound, video, menu art) and the lobby
FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server server
COPY assets assets
COPY --from=page /app/admiral-3d.html ./
USER node:node
EXPOSE 8080
CMD ["node", "server/server.js"]
