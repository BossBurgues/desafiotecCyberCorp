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
