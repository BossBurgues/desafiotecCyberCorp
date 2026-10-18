# Infra

- `docker-compose.yml`: ambiente completo (local = CI = VM): A, B, sync, Postgres 16 e Caddy
- `docker-compose.e2e.yml`: override dos testes E2E (caos agressivo, estado descartável)
- `caddy/Caddyfile`: reverse proxy com HTTPS automático, um host por sistema
- `scripts/`: smoke dos containers e utilitários

Hospedagem: VM Oracle Always Free (plano B: Render + Neon, ADR-010). Issues: épico **E4**.

## Subir tudo (S4.1)

```bash
cp .env.example .env                                                     # valores de desenvolvimento
docker compose -f infra/docker-compose.yml --env-file .env up -d --build --wait
docker compose -f infra/docker-compose.yml --env-file .env down          # -v apaga os volumes
```

| Serviço | Pela rede local | Pelo Caddy (`DOMAIN=localhost`) | Healthcheck |
|---|---|---|---|
| `system-a` | `127.0.0.1:3001` | `https://a.localhost` | `GET /health` (node) |
| `system-b` | `127.0.0.1:5002` | `https://b.localhost` (sem `/admin`) | binário com `--healthcheck` |
| `sync-service` | `127.0.0.1:3000` | `https://sync.localhost` | `GET /health` (node) |
| `postgres` | só na rede do compose | — | `pg_isready` |
| `caddy` | `:80` / `:443` | — | API de admin local `:2019` |

- **Segredos sem padrão:** `POSTGRES_PASSWORD`, `A_APP_TOKEN`, `A_UI_APP_TOKEN`, `A_TECNICO_PASSWORD`, `A_ESTAGIARIO_PASSWORD`, `A_SYNC_BOT_TOKEN`, `HMAC_SECRET` e `B_ADMIN_TOKEN` usam `${VAR:?}`: sem eles o compose nem sobe. Nunca cai num valor de desenvolvimento em produção.
- **Volumes nomeados:** `postgres-data`, `system-a-data`, `system-b-data`, `caddy-data` (certificados) e `caddy-config`. Os dados sobrevivem a `down`/`up`; só `down -v` apaga.
- **Ordem de subida:** o sync espera só o Postgres ficar saudável. A ou B fora não impedem a subida: o `/ready` mostra e o worker pausa. O Caddy espera os três apps.
- **Portas dos apps em `127.0.0.1`:** acessíveis na máquina (testes, depuração), nunca expostas na rede. Na VM, só o Caddy publica portas.
- **Admin do B fora da internet:** o Caddy responde 404 para `/admin` em `b.<DOMAIN>`. Caos e wipe só pela rede interna (o dashboard do sync, S3.10) ou por `127.0.0.1:5002`.
- **Imagens:** `IMAGE_PREFIX` e `IMAGE_TAG` (padrão `cybercorp/*:local`). Na VM apontam para o GHCR (`ghcr.io/<owner>/…:dev-<sha>`), e o deploy faz `pull` em vez de `build`.
- O webhook do A fica desligado (`A_WEBHOOK_ENABLED=false`) até o receptor do sync entrar na S3.4 (#32). O polling é a garantia (Q1).

## E2E (caos agressivo)

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.e2e.yml --env-file .env.example -p cybercorp-e2e up -d --build --wait
docker compose -f infra/docker-compose.yml -f infra/docker-compose.e2e.yml --env-file .env.example -p cybercorp-e2e down -v
```

O override **fixa** os valores (sem interpolação, para o `.env` de desenvolvimento não desligar o caos):

| O quê | Valor | Cenários |
|---|---|---|
| Seed do caos | 42 (reprodutível) | todos |
| 5xx / timeout (8 s, acima dos 5 s do sync) / grava e falha / ack sem gravar / 200 com erro / 429 | 10% / 5% / 5% / 3% / 5% / 5% | A1, A2, A3, B1, B5, E3, E4 |
| Paginação instável / atraso de listagem | 5% + 5% / 3 s | A7, E6 |
| Webhooks perdidos no A | 30% | B2 |
| Sync | `LOG_LEVEL=debug`, worker a cada 200 ms, disjuntor reabre em 5 s | — |
| Estado | Postgres e SQLites em `tmpfs`: cada execução começa do zero | — |
| Caddy | fora (perfil `caddy`); os testes usam as portas locais | — |

Combinações específicas de um cenário (drift de formato, texto truncado) são ligadas em tempo de execução pelo `PUT /admin/chaos`.

A CI builda a imagem do sync e valida os dois arquivos com `docker compose config`.
