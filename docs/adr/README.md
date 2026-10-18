# Architecture Decision Records

Um arquivo por decisão: `NNN-titulo.md`, com **Contexto**, **Decisão**, **Consequências** e **Alternativas consideradas**.

| ADR | Título | Status |
|---|---|---|
| [001](001-stack-poliglota-e-contratos.md) | Stack poliglota (A JS, B C#, Sync TS) e comunicação só por contratos | Aceito |
| [002](002-fila-no-postgres-skip-locked.md) | Fila no Postgres (`SKIP LOCKED`) em vez de broker | Aceito |
| [003](003-contrato-minimo-do-b.md) | Contrato mínimo do B: a única suposição | Aceito |
| [004](004-marcador-no-dado-e-teste-de-capacidade.md) | Marcador no dado como idempotência + teste de capacidade | Aceito |
| [005](005-evento-e-sinal-date-mod-e-hash-utc.md) | O evento é sinal: ler o estado atual do A; `date_mod` + hash em UTC | Aceito |
| [006](006-b-propoe-a-aprova-congelamento-sla.md) | O B propõe, o A aprova; status 5 e congelamento × SLA | Aceito (B→A opcional) |
| [007](007-exclusao-em-2-passos.md) | Exclusão em 2 passos; "excluído ou perdido" é decisão humana | Aceito (B→A opcional) |
| [008](008-transitorio-permanente-dlq-circuit-breaker.md) | Transitório × permanente; DLQ de 24 h; circuit breaker | Aceito |
| [009](009-anti-eco.md) | Anti-eco (`last_written_hash`, `sync-bot`) | Aceito (B→A opcional) |
| [010](010-hospedagem-oracle-compose.md) | Hospedagem Oracle + Compose; plano B Render + Neon | Aceito |
| [011](011-concorrencia-a-x-b.md) | Concorrência A×B: o A vence, ler antes de escrever, If-Match opcional | Aceito (B→A opcional) |

Para mudar uma decisão, copie o [modelo](000-modelo.md) e marque o ADR antigo como *Substituído por ADR-XXX*.
