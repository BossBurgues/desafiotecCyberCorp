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

Issues: épicos **E3**, **E5**, **E6** e **E7**.
