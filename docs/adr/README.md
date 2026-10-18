# Architecture Decision Records

Um arquivo por decisão: `NNN-titulo.md`, com **Contexto**, **Decisão**, **Consequências** e **Alternativas consideradas**.

| ADR | Título |
|---|---|
| 001 | Stack poliglota (A JS, B C#, Sync TS) e comunicação só por contratos |
| 002 | Fila no Postgres (`SKIP LOCKED`) em vez de broker |
| 003 | Contrato mínimo do B: a única suposição |
| 004 | Marcador no dado como idempotência + teste de capacidade |
| 005 | O evento é sinal: ler o estado atual do A; `date_mod` + hash em UTC |
| 006 | O B propõe, o A aprova; status 5 e congelamento × SLA |
| 007 | Exclusão em 2 passos; "excluído ou perdido" é decisão humana |
| 008 | Transitório × permanente; DLQ de 24 h; circuit breaker |
| 009 | Anti-eco (`last_written_hash`, `sync-bot`) |
| 010 | Hospedagem Oracle + Compose; plano B Render + Neon |
| 011 | Concorrência A×B: o A vence, ler antes de escrever, If-Match opcional |

Issue: **S0.3**.
