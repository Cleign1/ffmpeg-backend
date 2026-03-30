FROM node:22-alpine AS deps

WORKDIR /app

RUN apk add --no-cache ffmpeg

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile


FROM node:22-alpine AS runner

WORKDIR /app

RUN apk add --no-cache ffmpeg tini \
  && addgroup -S appgroup \
  && adduser -S appuser -G appgroup

ENV NODE_ENV=production \
  PORT=3000 \
  SONGS_DIR=/data/songs \
  DATA_DIR=/data/song_data \
  TEMP_DIR=/data/temp

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN mkdir -p "$SONGS_DIR" "$DATA_DIR" "$TEMP_DIR" \
  && chown -R appuser:appgroup /app /data

EXPOSE 3000

USER root
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.mjs"]