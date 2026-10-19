# syntax=docker/dockerfile:1
# Contexto de build: raiz do repositório (o package-lock.json é do monorepo).
#   docker build -f apps/sync-service/Dockerfile -t sync-service .
ARG NODE_IMAGE=node:20.20.2-bookworm-slim

# Compila o TypeScript com as dependências de desenvolvimento
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/system-a/package.json apps/system-a/
COPY apps/sync-service/package.json apps/sync-service/
COPY tests/e2e/package.json tests/e2e/
RUN npm ci --workspace apps/sync-service --include-workspace-root=false --ignore-scripts --no-audit --no-fund
COPY apps/sync-service/tsconfig.json apps/sync-service/tsconfig.build.json apps/sync-service/
COPY apps/sync-service/src apps/sync-service/src
RUN npm run build -w apps/sync-service

# Só as dependências de produção (sem nativas: nada a compilar)
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/system-a/package.json apps/system-a/
COPY apps/sync-service/package.json apps/sync-service/
COPY tests/e2e/package.json tests/e2e/
RUN npm ci --omit=dev --workspace apps/sync-service --include-workspace-root=false --ignore-scripts --no-audit --no-fund \
    && mkdir -p apps/sync-service/node_modules

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Dependências que o npm não içou para a raiz (versões em conflito com o A) ficam na pasta do workspace
COPY --from=deps /app/apps/sync-service/node_modules ./apps/sync-service/node_modules
COPY apps/sync-service/package.json apps/sync-service/
COPY --from=build /app/apps/sync-service/dist apps/sync-service/dist
# As migrations rodam na subida (src/infra/db/migrate.ts lê ../../../migrations a partir de dist)
COPY apps/sync-service/migrations apps/sync-service/migrations
# Página do dashboard (S3.10), servida de ../../../public a partir de dist
COPY apps/sync-service/public apps/sync-service/public
USER node
EXPOSE 3000
# /health é liveness: não olha o B, para o B instável não fazer o orquestrador reiniciar o sync
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Forma exec: o Node é o PID 1 e recebe o SIGTERM direto (desligamento limpo do worker)
CMD ["node", "apps/sync-service/dist/main.js"]
