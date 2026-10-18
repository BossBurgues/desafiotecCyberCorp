# ADR-005: O evento é sinal: ler o estado atual do A; `date_mod` + hash em UTC

- **Status:** Aceito
- **Data:** 16/10/2026
- **Decisões do plano:** Q1, Q2, Q11 (seções 2, 4, 5 e 10 do `PLANO_DE_ACAO.md`)

## Contexto
Webhooks podem chegar fora de ordem, duplicados ou se perder na rede; além disso, o modelo de dados estilo GLPI no Sistema A não possui um contador incremental de versão por chamado, e múltiplos updates podem ocorrer dentro do mesmo segundo de `date_mod`.

## Decisão
- Combinar **webhook + polling**: o polling periódico (padrão a cada 10 s, com **sobreposição de 2 min** sobre `poll_checkpoint`) é a garantia contra perda; o webhook é apenas um acelerador de baixa latência e pode ser desligado (`A_WEBHOOK_ENABLED`).
- Tratar todo evento recebido (webhook ou poll) **apenas como sinal** (`ticket_id`): o payload nunca é gravado direto no B; o worker **sempre faz `GET` no estado atual do A** antes de decidir o que enviar.
- Definir "estado mais novo" combinando `date_mod` (convertido do fuso explícito `A_TIMEZONE` para UTC) + **hash canônico dos campos sincronizáveis** (o cálculo do hash ignora `date_mod`). Se o hash atual for igual a `last_synced_hash`, o job encerra como no-op idempotente.
- **Ignorar o relógio do Sistema B**: toda comparação temporal usa exclusivamente UTC e o instante observado pelo sincronizador.

## Consequências
- **Fica mais fácil:** impedir que um webhook atrasado ou um retry antigo sobrescreva um dado mais novo (proibição #3); recuperar automaticamente webhooks perdidos via poller (proibição #2); absorver múltiplos updates rápidos em uma única escrita atualizada.
- **Fica mais difícil:** cada job executa uma leitura HTTP extra (`GET`) no Sistema A; a sobreposição de 2 min no polling relê chamados recém-sincronizados (descartados sem custo no B porque o hash bate com `last_synced_hash`).
- **Risco que sobra:** configuração incorreta de `A_TIMEZONE`, mitigada por validação explícita de configuração e testes de fuso/horário de verão.

## Alternativas consideradas
| Alternativa | Por que não |
|---|---|
| Aplicar diretamente o payload enviado no corpo do webhook | Eventos fora de ordem ou reentregas antigas sobrescreveriam o estado mais recente no B. |
| Inventar uma coluna `version` sequencial no Sistema A | Descaracteriza o contrato estilo GLPI, que expõe apenas `date_mod`. |
| Comparar timestamps entre o relógio do A e o relógio do B | O relógio do B não é confiável (ADR-003) e pode sofrer drift sem aviso. |

## Onde está no código / como provar
- Garantias **Dado antigo não sobrescreve novo** e **Nenhuma atualização perdida** (seção 5 do plano).
- Implementação em `apps/sync-service/src/domain/` (hash e fuso), `apps/sync-service/src/infra/scheduler/` (poller) e `apps/sync-service/src/application/`.
- Cenários B2 (webhook perdido), B4, B6, B11 (fuso/horário de verão), B12 (dois updates no mesmo segundo), C1 (eventos fora de ordem), C2 (retry atrasado) e C6 (relógio do B errado).
