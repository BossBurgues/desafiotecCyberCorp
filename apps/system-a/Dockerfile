# syntax=docker/dockerfile:1
# Contexto de build: raiz do repositório (o package-lock.json é do monorepo).
#   docker build -f apps/system-a/Dockerfile -t system-a .
ARG NODE_IMAGE=node:20.20.2-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# Fallback de compilação do better-sqlite3 quando não houver prebuild (ex.: arm64); não vai para a imagem final
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/system-a/package.json apps/system-a/
COPY apps/sync-service/package.json apps/sync-service/
COPY tests/e2e/package.json tests/e2e/
RUN npm ci --omit=dev --workspace apps/system-a --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=3001 A_DB_PATH=/data/system-a.db
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/system-a/node_modules ./apps/system-a/node_modules
COPY apps/system-a/package.json apps/system-a/
COPY apps/system-a/src apps/system-a/src
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Forma exec: o Node é o PID 1 e recebe o SIGTERM direto
CMD ["node", "apps/system-a/src/server.js"]
