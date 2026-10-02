# Runs the cinema server. Mount your movies folder at /movies.
#   docker build -t cinema-3d .
#   docker run -p 3000:3000 -v /path/to/your/movies:/movies -e ACCESS_PIN=123456 cinema-3d
FROM node:22-bookworm-slim

# System FFmpeg, used when the bundled binary doesn't exist for this CPU
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js index.html login.html ./
COPY css ./css
COPY js ./js
COPY assets ./assets

ENV PORT=3000 \
    MOVIES_DIR=/movies \
    THUMBNAILS_DIR=/data/thumbnails
VOLUME ["/movies", "/data"]
EXPOSE 3000

USER node
CMD ["node", "server.js"]
