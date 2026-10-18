# ADR-008: Transitório × permanente; DLQ de 24 h; circuit breaker

- **Status:** Aceito
- **Data:** 16/10/2026
- **Decisões do plano:** Q25 (seções 2, 5, 8 e 10 do `PLANO_DE_ACAO.md`)

## Contexto
O Sistema B apresenta falhas intermitentes e prolongadas (timeouts de 5 s, 429 Too Many Requests, 5xx, `200 OK` com corpo de erro) além de rejeições de validação (400/422, drift de esquema). Um limite pequeno de tentativas perderia atualizações quando o B ficasse fora do ar por horas; por outro lado, insistir por 24 h em um erro permanente entupiria a fila.

## Decisão
- Classificar cada falha em `error_class` na tabela `sync_jobs`:
  - **Transitório** (timeout, erro de rede, 429, 5xx, 200-com-erro transitório): aplicar backoff exponencial `1 s × 2ⁿ + jitter` com **teto de 5 min**, tentando por **até 24 h** desde `first_failed_at` antes de mover para a DLQ (`status = 'dead'`). Se o atraso passar de 10 min, postar uma única nota de aviso no chamado do A.
  - **Permanente** (400/422, falha de validação ou drift de esquema): tentar no máximo **3 vezes** e mover para a DLQ (`status = 'dead'`).
- **Circuit breaker no adaptador do B:** abre após **5 falhas consecutivas** e entra em meia-abertura após **30 s**. Enquanto o disjuntor estiver aberto, os jobs **aguardam reagendamento sem incrementar `attempts`**, protegendo o B e não queimando tentativas.
- **DLQ e reprocessamento:** todo item em `dead` gera alerta em `alerts_outbox` e aparece no dashboard; ao acionar reprocessamento manual, o worker **sempre relê o estado atual do A** (ADR-005), nunca reenviando payload antigo congelado.
- Todos os parâmetros são configuráveis via variáveis de ambiente (seção 10).

## Consequências
- **Fica mais fácil:** sobreviver a quedas longas do Sistema B sem perder nenhuma atualização (proibição #2) e isolar rapidamente erros de contrato na DLQ.
- **Fica mais difícil:** chamadas com falha transitória podem levar horas até convergir quando o B está indisponível (compensado pelo alerta no dashboard e pela nota única de atraso após 10 min).
- **Risco que sobra:** indisponibilidade do B superior a 24 h, caso em que o job vai para a DLQ com alerta explícito e pode ser reprocessado assim que o B voltar.

## Alternativas consideradas
| Alternativa | Por que não |
|---|---|
| Número fixo pequeno de tentativas (ex.: 5 retries) para tudo | Uma queda de 15 minutos no Sistema B esgotaria as tentativas e jogaria chamados válidos na DLQ. |
| Retry infinito para qualquer erro | Erros 400/422 ou drift de formato ficariam rodando para sempre sem visibilidade clara de DLQ. |
| Retries sem circuit breaker | Martela o Sistema B degradado e consome todas as tentativas dos jobs na fila durante uma queda geral. |

## Onde está no código / como provar
- Garantia **Nenhuma atualização perdida** (seção 5 do plano).
- Implementação em `apps/sync-service/src/adapters/system-b/` (circuit breaker) e `apps/sync-service/src/infra/queue/` (backoff e DLQ).
- Cenários B1 (B fora por 1 h), B10 (reprocessar da DLQ relê o A), E1 (drift → DLQ permanente), E3 (429), E4 (B lento → timeout + breaker), E7 (B fora > 24 h → DLQ + nota) e G4 (422 → DLQ).
