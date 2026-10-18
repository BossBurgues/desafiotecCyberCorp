# ADR-004: Marcador no dado como idempotência + teste de capacidade

- **Status:** Aceito
- **Data:** 16/10/2026
- **Decisões do plano:** Q30, Q35 (seções 2, 5, 7 e 10 do `PLANO_DE_ACAO.md`)

## Contexto
Sob o contrato mínimo do Sistema B (ADR-003), não há `Idempotency-Key` nem busca por referência externa. Quando uma requisição de criação sofre timeout, erro 5xx ou `commit-then-fail`, o sincronizador não sabe se o registro foi criado ou não no B; reenviar o `POST` às cegas violaria a proibição #1 (chamado duplicado).

## Decisão
- Embutir um **marcador determinístico** `⟦s:glpi-<id>⟧` no fim do campo de texto configurado (`B_MARKER_FIELD`, padrão `description`) ao criar ou atualizar um registro no Sistema B.
- Manter a tabela local `ticket_mapping` relacionando `a_ticket_id` e `b_record_id`.
- **Nunca reenviar um create às cegas:** se a criação retornar resultado ambíguo, marcar o mapeamento como `create_uncertain`, varrer a listagem paginada do B procurando o marcador `⟦s:glpi-<id>⟧` e **só recriar após 2 varreduras completas** sem encontrá-lo (seção 10).
- Executar um **teste de capacidade na inicialização** (grava um registro de teste no B, relê e verifica se o marcador sobrevive intacto). Se o B truncar ou remover o marcador, entrar em **modo seguro**: criações ambíguas vão para `quarantine` + alerta, nunca para recriação automática.
- Se um operador do B apagar o marcador de um registro já mapeado, o auditor detecta pelo `b_record_id`, regrava o marcador e registra o evento no `audit_log`.
- Aplicar o mesmo padrão de marcador às notas e comentários (`⟦n:…⟧` e `⟦from-b:…⟧`, com `note_mapping`).

## Consequências
- **Fica mais fácil:** garantir zero duplicatas mesmo diante de timeouts, quedas de rede ou listagem atrasada, sem depender de recursos especiais do B.
- **Fica mais difícil:** a recuperação de um create ambíguo que realmente falhou leva o tempo de 2 ciclos de varredura antes de recriar; o marcador textual fica visível no final da descrição para o Operador B.
- **Risco que sobra:** o Sistema B passar a truncar textos após a inicialização, coberto pela verificação pós-escrita e pelo auditor (entrando em modo seguro).

## Alternativas consideradas
| Alternativa | Por que não |
|---|---|
| `Idempotency-Key` no cabeçalho HTTP | Não faz parte do contrato mínimo assumido para o Sistema B (ADR-003). |
| Confiar apenas no mapeamento local (`ticket_mapping`) | Se a conexão cair antes de receber a resposta do `POST`, o mapeamento local ainda não tem o `b_record_id` gerado pelo B. |
| Enviar o ID do A como ID primário do B | O Sistema B gera seus próprios identificadores ao criar registros. |

## Onde está no código / como provar
- Garantia **Nenhum chamado/nota duplicado** (seção 5 do plano).
- Implementação em `apps/sync-service/src/domain/` (marcador) e `apps/sync-service/src/adapters/system-b/`.
- Cenários A1 (`commit-then-fail`), A2 (timeout com gravação tardia), A3 (200 com erro), A7 (listagem atrasada), A8 (nota com timeout), A9, A10 e E2 (B remove o marcador → modo seguro).
