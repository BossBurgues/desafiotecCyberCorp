# Sync Service (Node.js + TypeScript)

⭐ **O que é avaliado.** Mantém os chamados do A sincronizados no B sem duplicar, sem perder atualizações e sem deixar dado antigo sobrescrever o novo.

| Pasta | Responsabilidade |
|---|---|
| `src/domain` | Regras **puras** (sem I/O): conversão A→B, hash, fuso, marcador |
| `src/application` | Casos de uso: processar job (create/update idempotente + verificação pós-escrita) e poller do A |
| `src/adapters/system-a` | Cliente do A (entra como `sync-bot`) |
| `src/adapters/system-b` | Cliente do B: timeout, circuit breaker, validação de resposta, marcador |
| `src/infra/db` | Repositórios Postgres |
| `src/infra/queue` | Worker (`SKIP LOCKED`, lease, backoff, DLQ) |
| `src/infra/http` | Fastify: webhook, `/health`, `/ready`, `/metrics`, dashboard |
| `migrations` | Esquema do banco |
| `test/unit`, `test/integration` | Testes |

## Como rodar (S3.1)

```bash
npm run build -w apps/sync-service
DATABASE_URL=postgres://sync:sync@localhost:5432/sync A_BASE_URL=http://localhost:3001 B_BASE_URL=http://localhost:5002 \n  A_APP_TOKEN=dev-app-token A_SYNC_BOT_TOKEN=dev-sync-bot-token HMAC_SECRET=dev-hmac-secret-troque-em-producao-0000 \n  npm run start -w apps/sync-service        # aplica as migrations e sobe em :3000
```

Na subida, em ordem: **valida a config** (zod; qualquer variável inválida lista todos os problemas e sai com código 1, sem imprimir valores) → **aplica as migrations** pendentes → checa as dependências → inicia o worker e o poller do A → abre o HTTP (com o webhook). `SIGTERM` fecha o HTTP, espera o tick em andamento do worker e encerra o pool.

| Variável | Padrão | Para quê |
|---|---|---|
| `DATABASE_URL` | **obrigatória** | Postgres do sync (`postgres://…`) |
| `A_BASE_URL` / `B_BASE_URL` | **obrigatórias** | Base HTTP do A e do B (checadas em `GET /health`) |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Endereço do HTTP |
| `LOG_LEVEL` | `info` | Nível do pino |
| `READY_CHECK_TIMEOUT_MS` | `2000` | Tempo máximo de cada checagem de dependência |
| `READY_CHECK_INTERVAL_MS` | `5000` | De quanto em quanto tempo o worker reavalia a prontidão |
| `WORKER_POLL_INTERVAL_MS` | `1000` | Intervalo entre ticks do worker |
| `B_TIMEOUT_MS` | `5000` | Timeout de cada requisição ao B |
| `B_BREAKER_THRESHOLD` / `B_BREAKER_OPEN_MS` | `5` / `30000` | Falhas seguidas que abrem o disjuntor e quanto tempo ele fica aberto |
| `QUEUE_LEASE_MS` | `60000` | Lease do job (renovado a cada terço enquanto roda) |
| `QUEUE_BACKOFF_BASE_MS` / `QUEUE_BACKOFF_MAX_MS` | `1000` / `300000` | Backoff 1 s·2ⁿ + jitter, teto de 5 min |
| `QUEUE_TRANSIENT_MAX_AGE_MS` | `86400000` | Erro transitório vai para a DLQ depois de 24 h desde a primeira falha |
| `QUEUE_PERMANENT_MAX_ATTEMPTS` | `3` | Erro permanente vai para a DLQ nesta tentativa |
| `WORKER_MAX_JOBS_PER_TICK` | `20` | Jobs processados por tick do worker |
| `A_APP_TOKEN` / `A_SYNC_BOT_TOKEN` | **obrigatórias** | Credenciais do sync no A (App-Token + `user_token` do sync-bot) |
| `A_TIMEZONE` | `America/Sao_Paulo` | Fuso do `date_mod` do A (conversão para UTC e limite do poll) |
| `A_TIMEOUT_MS` | `5000` | Timeout de cada requisição ao A |
| `HMAC_SECRET` | **obrigatória** (≥ 16) | Segredo do webhook do A |
| `WEBHOOK_REPLAY_WINDOW_MS` | `300000` | Janela anti-replay do `X-Timestamp` (5 min) |
| `POLL_INTERVAL_MS` / `POLL_OVERLAP_MS` / `POLL_PAGE_SIZE` | `10000` / `120000` / `100` | Poller do A: intervalo, sobreposição e tamanho da página |
| `B_MARKER_FIELD` | `description` | Campo do B que carrega o marcador `⟦s:glpi-id⟧` (`description` ou `title`) |
| `CREATE_UNCERTAIN_SCANS` | `2` | Varreduras da listagem do B sem achar o marcador antes de recriar um create ambíguo |
| `B_LIST_PAGE_SIZE` | `100` | Página usada na varredura do B |
| `B_ADMIN_TOKEN` | — | Admin do B para o painel de caos do dashboard (sem ele, o painel fica desligado) |
| `DASHBOARD_USER`, `DASHBOARD_PASSWORD` | — | Login do dashboard e do `/metrics` (HTTP Basic, senha com 12+ caracteres). **Sem os dois, o dashboard não é registrado** (404) |
| `DASHBOARD_CONTROLS` | `false` | `true` liga reprocessar a DLQ e mexer no caos pelo dashboard (sempre atrás do login) |

### HTTP

| Rota | Resposta |
|---|---|
| `GET /health` | 200 `{ "status": "ok" }` sempre que o processo responde (liveness; não olha dependências, para o B instável não fazer o orquestrador reiniciar o sync) |
| `GET /ready` | 200 ou **503** com `checks.postgres`, `checks.system_a`, `checks.system_b` (`ok`, `latency_ms`, `error`). Cenário **H5**: sem Postgres → 503 |
| `GET /dashboard` | **Login obrigatório** (S5.3): sem credenciais, `/dashboard`, `/api/dashboard/*` e `/metrics` respondem **401**. Dashboard (S3.10): fila, DLQ com o motivo e botão de reprocessar, mapeamentos, caixa de saída de alertas, disjuntor do B e painel de caos. Atualiza a cada 2 s |
| `GET /api/dashboard/summary` | JSON do dashboard |
| `POST /api/dashboard/dlq/:id/reprocess` | Job novo que relê o A. **403** com `DASHBOARD_CONTROLS=false` |
| `GET` / `PUT /api/dashboard/chaos`, `POST /api/dashboard/chaos/reset` | Repassa ao `/admin/chaos` do B com o `X-Admin-Token`. **503** sem `B_ADMIN_TOKEN`; escrita **403** sem controles |
| `GET /metrics` | Prometheus: `sync_jobs{status}`, `sync_dlq_pending`, `sync_ticket_mappings{state}`, `sync_b_circuit_breaker` |
| `POST /webhooks/system-a` | Webhook `ticket.changed` do A. **401** sem assinatura válida ou fora da janela; **400** fora do contrato; **200** `{ accepted, duplicate }` depois de gravar evento + job |

### Logs e `correlation_id`

Logs JSON do pino. Cada requisição recebe um `correlation_id`: reaproveita o `x-correlation-id` recebido (só `[A-Za-z0-9._:-]`, até 128 caracteres, para não forjar linha de log) ou gera um UUID, e devolve no cabeçalho de resposta. Cabeçalhos de credencial (`authorization`, `app-token`, `session-token`, `x-admin-token`, assinatura do webhook) saem como `[mascarado]`.

### Worker

O laço (`src/infra/queue/worker-loop.ts`) **pausa enquanto `/ready` falha**: sem Postgres, A ou B, pegar job só gastaria tentativas. Loga uma vez ao pausar e uma ao retomar. Cada tick chama `drain` com o `processJob` (S3.6, ver [`docs/how-it-works.md`](../../docs/how-it-works.md)).

### Fila (S3.3, ADR-002 e ADR-008)

`src/infra/queue/queue.ts` usa a tabela `sync_jobs`, sem broker:

- **`enqueue`**: upsert no índice único parcial (um job `pending`/`running` por chamado). Evento repetido **aglutina**. Se o job já está rodando, marca `rerun`: o worker pode ter lido o A antes da mudança, então, ao concluir, o job volta para `pending` em vez de virar `done` (nenhuma mudança se perde na aglutinação).
- **`claim`**: `SELECT … FOR UPDATE SKIP LOCKED` nos jobs vencidos. Dois workers nunca pegam o mesmo job e nenhum espera o outro. Cada claim gera um `lease_token` e `locked_until`. Lease vencido (worker caiu) é retomado e conta como tentativa transitória, para um job que derruba o worker não girar para sempre.
- **`complete` / `fail` / `extendLease`** exigem o `lease_token`: um worker lento cujo lease já foi para outro não sobrescreve nada (`lost_lease`).
- **`fail`**: transitório → backoff `1 s·2ⁿ + jitter` (teto de 5 min) por até 24 h desde `first_failed_at`. Permanente → 3 tentativas. Depois disso, `dead` (DLQ) + linha em `alerts_outbox`. Disjuntor aberto (`circuit_open`) espera o tempo restante **sem gastar tentativa**. `Retry-After` maior que o backoff vence.
- **`reprocessDead`**: o job não guarda payload. Reprocessar cria um job novo para o chamado, e o worker **relê o estado atual do A**. O item morto fica como histórico (`reprocessed_at`).
- **`runner.ts`**: `runOnce`/`drain` pegam o job, renovam o lease enquanto o processador roda e classificam o erro (`BError` do adapter, `MappingError` = permanente, desconhecido = transitório).

Migration `002_queue_lease_rerun.sql`: `lease_token`, `rerun`, `reprocessed_at` e o índice da DLQ.

### Adapter do B (S3.5, ADR-003 e ADR-008)

`src/adapters/system-b/client.ts` fala com `/api/v2` tratando o B como hostil:

| Situação | Classe | `reason` | Observação |
|---|---|---|---|
| Sem resposta em `B_TIMEOUT_MS` | transitório | `timeout` | ambíguo em escrita (gravação tardia, A2) |
| Rede (conexão recusada/resetada) | transitório | `network` | ambíguo em escrita |
| 5xx / 408 | transitório | `server_error` | ambíguo em escrita (grava e falha, A1) |
| 2xx com `{ error, message }` | transitório | `error_body` | ambíguo em escrita (A3) |
| 2xx que não é JSON | transitório | `invalid_body` | |
| 429 | transitório | `rate_limited` | espera o `Retry-After` (1 s sem cabeçalho, teto de 60 s) antes da próxima chamada; não conta para o disjuntor |
| Disjuntor aberto | transitório | `circuit_open` | a requisição nem sai; `retryAfterMs` = tempo até a meia-abertura |
| 412 (`If-Match`) | transitório | `precondition_failed` | reler e tentar de novo (ADR-011) |
| 400 / 422 / outros 4xx | permanente | `rejected` | o B recusou; repetir não muda nada |
| 404 | permanente | `not_found` | `getRecord` devolve `null`; no `PUT`, o `processJob` procura o marcador e adota ou recria depois de N varreduras (S3.8). A exclusão com decisão humana (ADR-007) é do B → A opcional |
| 2xx fora do contrato (campo renomeado, a mais, tipo errado) | permanente | `schema_drift` | E1; zod estrito espelhando o `additionalProperties: false` do contrato |

Disjuntor (`circuit-breaker.ts`): abre depois de 5 falhas transitórias seguidas, fica aberto 30 s e então deixa passar **uma** requisição de teste (sucesso fecha, falha reabre). 4xx e drift não contam: o B respondeu. A resposta 2xx é sempre validada antes de chegar ao caso de uso, e `ambiguous` diz ao create se ele precisa ir para `create_uncertain` em vez de reenviar (ADR-004).

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
