# Sync Service (Node.js + TypeScript)

⭐ **O que é avaliado.** Mantém os chamados do A sincronizados no B sem duplicar, sem perder atualizações e sem deixar dado antigo sobrescrever o novo.

| Pasta | Responsabilidade |
|---|---|
| `src/domain` | Regras **puras** (sem I/O): conversão A→B, hash, fuso, classificação de mudanças |
| `src/application` | Casos de uso: processar job, detectar mudanças no B, aprovar/recusar |
| `src/adapters/system-a` | Cliente do A + receptor de webhook |
| `src/adapters/system-b` | Cliente do B: timeout, circuit breaker, validação de resposta, marcador |
| `src/infra/db` | Repositórios Postgres |
| `src/infra/queue` | Worker (`SKIP LOCKED`, lease, backoff, DLQ) |
| `src/infra/scheduler` | Poller do A e auditor do B |
| `src/infra/http` | Fastify: webhook, `/health`, `/ready`, `/metrics`, dashboard |
| `migrations` | Esquema do banco |
| `test/unit`, `test/integration` | Testes |

## Como rodar (S3.1)

```bash
npm run build -w apps/sync-service
DATABASE_URL=postgres://sync:sync@localhost:5432/sync A_BASE_URL=http://localhost:3001 B_BASE_URL=http://localhost:5002   npm run start -w apps/sync-service        # aplica as migrations e sobe em :3000
```

Na subida, em ordem: **valida a config** (zod; qualquer variável inválida lista todos os problemas e sai com código 1, sem imprimir valores) → **aplica as migrations** pendentes → checa as dependências → inicia o worker → abre o HTTP. `SIGTERM` fecha o HTTP, espera o tick em andamento do worker e encerra o pool.

| Variável | Padrão | Para quê |
|---|---|---|
| `DATABASE_URL` | **obrigatória** | Postgres do sync (`postgres://…`) |
| `A_BASE_URL` / `B_BASE_URL` | **obrigatórias** | Base HTTP do A e do B (checadas em `GET /health`) |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Endereço do HTTP |
| `LOG_LEVEL` | `info` | Nível do pino |
| `READY_CHECK_TIMEOUT_MS` | `2000` | Tempo máximo de cada checagem de dependência |
| `READY_CHECK_INTERVAL_MS` | `5000` | De quanto em quanto tempo o worker reavalia a prontidão |
| `WORKER_POLL_INTERVAL_MS` | `1000` | Intervalo entre ticks do worker |

### HTTP

| Rota | Resposta |
|---|---|
| `GET /health` | 200 `{ "status": "ok" }` sempre que o processo responde (liveness; não olha dependências, para o B instável não fazer o orquestrador reiniciar o sync) |
| `GET /ready` | 200 ou **503** com `checks.postgres`, `checks.system_a`, `checks.system_b` (`ok`, `latency_ms`, `error`). Cenário **H5**: sem Postgres → 503 |

### Logs e `correlation_id`

Logs JSON do pino. Cada requisição recebe um `correlation_id`: reaproveita o `x-correlation-id` recebido (só `[A-Za-z0-9._:-]`, até 128 caracteres, para não forjar linha de log) ou gera um UUID, e devolve no cabeçalho de resposta. Cabeçalhos de credencial (`authorization`, `app-token`, `session-token`, `x-admin-token`, assinatura do webhook) saem como `[mascarado]`.

### Worker

O laço (`src/infra/queue/worker-loop.ts`) **pausa enquanto `/ready` falha**: sem Postgres, A ou B, pegar job só gastaria tentativas. Loga uma vez ao pausar e uma ao retomar. O processamento dos jobs entra na S3.3.

### Migrations

`migrations/NNN_*.sql`, aplicadas em ordem por `src/infra/db/migrate.ts`, cada uma numa transação, registradas em `schema_migrations` e protegidas por advisory lock (duas instâncias subindo juntas não aplicam a mesma duas vezes). `001_initial.sql` cria as tabelas da seção 8 do plano: `inbound_events`, `sync_jobs` (índice único parcial: **um job ativo por chamado**, ADR-002), `ticket_mapping`, `proposals`, `note_mapping`, `audit_log`, `poll_checkpoint` e `alerts_outbox`. A proteção append-only do `audit_log` fica para a S5.1.

### Testes

```bash
npm run test -w apps/sync-service                                    # unitários; integração é pulada
TEST_DATABASE_URL=postgres://... npm run test -w apps/sync-service   # + migrations e /ready com Postgres de verdade
```

Cada arquivo de integração usa um schema novo e o apaga no fim. Na CI o job sobe um Postgres 16 como service e `TEST_DATABASE_URL` é obrigatório (sem ele, os testes de integração falham em vez de pular).

## Domínio (`src/domain`)

Regras 100% puras (sem banco, rede, arquivos, variáveis de ambiente ou relógio do sistema; veja [`docs/field-mapping.md`](../../docs/field-mapping.md)):

- `types.ts`: tipos `GlpiTicket`, `RecordInput`, `BRecord`, `Lookups` e `MapTicketOptions` espelhando os contratos OpenAPI do A e do B.
- `errors.ts`: `MappingError` (`permanent = true`, `field`, `value`) para dados que nunca poderão ser convertidos (vão direto para a DLQ sem gastar tentativas de rede).
- `status.ts`: tabelas `STATUS_TO_STATE` (`1..6` → `OPEN`, `IN_PROGRESS`, `ON_HOLD`, `RESOLVED`, `CLOSED`, com `3 Planejado → IN_PROGRESS`) e `PRIORITY_TO_SEVERITY` (`1..6` → `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`).
- `html-to-text.ts`: `htmlToText` converte o HTML do A em texto puro seguro (remove `<script>`, `<style>`, `<head>`, comentários, tags e atributos de evento, decodifica entidades e preserva acentos e emojis em tempo linear).
- `text.ts`: `neutralizeMarkers` troca `⟦`/`⟧` vindos do A por `[`/`]` (impede forjar marcador) e `normalizeTitle` apara espaços e corta em até 200 code points sem partir grafemas (`Intl.Segmenter`).
- `marker.ts`: `markerFor(aId)` gera `⟦s:glpi-<id>⟧`, `appendMarker` anexa o marcador no fim de `description` (ou `title`) e `findMarker` extrai o ID na varredura de reconciliação (ADR-004).
- `time.ts`: `glpiLocalToUtc` e `utcToGlpiLocal` convertem `date_mod` entre `A_TIMEZONE` e UTC (tratando hora repetida e hora inexistente no horário de verão), e `pollLowerBoundLocal` calcula o limite inferior do poll pelo menor offset do intervalo (cenário B11).
- `mapper.ts`: `mapTicketToRecord(ticket, options)` monta o `RecordInput` completo a partir do chamado do A.
- `hash.ts`: `canonicalJson`, `hashTicket` (apenas os 9 campos sincronizáveis do A, ignorando `date_mod` para evitar eco) e `hashRecord` (ignora `sourceUpdatedAt` e os metadados/relógio do B).

### Como validar e rodar os testes do domínio

```bash
npm run typecheck -w apps/sync-service
npm run test -w apps/sync-service
```

O script `test` executa o Vitest com cobertura V8 e exige **100%** de linhas, branches, funções e statements em `src/domain/**`.

Issues: épicos **E3**, **E5**, **E6** e **E7**.
