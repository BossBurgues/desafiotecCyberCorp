# ADR-002: Fila no Postgres (`SKIP LOCKED`) em vez de broker

- **Status:** Aceito
- **Data:** 16/10/2026
- **Decisões do plano:** Arquitetura (seção 4), Garantias (seção 5) e Modelo de dados (seção 8 do `PLANO_DE_ACAO.md`)

## Contexto
O sincronizador precisa de uma fila durável que suporte retry agendado com backoff, lease de execução (para não perder jobs se o worker cair no meio) e a garantia de que exista apenas um job pendente por chamado — tudo isso operando com baixa complexidade em uma VM pequena gratuita.

## Decisão
- Usar a tabela `sync_jobs` no mesmo banco PostgreSQL do `sync-service` como fila de trabalho.
- Os workers buscam o próximo job elegível (`status = 'pending'` e `next_run_at <= now()`, ou `status = 'running'` com lease vencido) usando `SELECT ... FOR UPDATE SKIP LOCKED`.
- Manter um **índice único parcial** por `ticket_id` enquanto o job estiver ativo (`pending`/`running`), aglutinando múltiplos eventos repetidos do mesmo chamado em um único job.
- Controlar falhas de processo com `locked_until` (lease do worker) e o agendamento de novas tentativas com `next_run_at`.

## Consequências
- **Fica mais fácil:** gravar o evento recebido, atualizar o mapeamento (`ticket_mapping`) e enfileirar/atualizar o job na **mesma transação ACID**, eliminando o risco de perda entre banco e broker; operar um componente a menos na infraestrutura.
- **Fica mais difícil:** escalar para dezenas de milhares de mensagens por segundo (não aplicável ao escopo do desafio, documentado em `docs/out-of-scope.md`).
- **Risco que sobra:** polling periódico na tabela `sync_jobs`, mitigado por índices parciais enxutos nos registros pendentes.

## Alternativas consideradas
| Alternativa | Por que não |
|---|---|
| RabbitMQ ou Kafka | Mais um serviço para manter e monitorar na VM gratuita; sem transação conjunta com o Postgres, exigiria uma tabela outbox no banco de qualquer forma. |
| Redis / BullMQ | Persistência menos rígida que o Postgres por padrão e adiciona outra dependência de infraestrutura sem eliminar a necessidade de estado relacional. |
| AWS SQS | Dependência de nuvem externa específica e sem deduplicação nativa por chamado ativo sem configuração extra. |

## Onde está no código / como provar
- Garantias de **duplicata** e **antigo sobre novo** (um job por chamado, sem envios concorrentes) e de **perda** (lease `locked_until`) na seção 5 do plano.
- Implementação em `apps/sync-service/migrations/` e `apps/sync-service/src/infra/queue/`.
- Cenários A4, A5, A6, B3, B6 e B9 (seção 12 do plano).
