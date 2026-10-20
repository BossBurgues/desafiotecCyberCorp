# ADR-007: Exclusão em 2 passos; "excluído ou perdido" é decisão humana

- **Status:** Substituído pelo [ADR-015](015-exclusao-nos-dois-lados-e-o-mestre.md) (19/10/2026): implementado sem aprovação, com a lixeira do A e a lápide do B (410 = excluído, 404 = perdido)
- **Data:** 16/10/2026
- **Decisões do plano:** Q5, Q9, Q12, Q20 (seções 2, 4, 5 e 8 do `PLANO_DE_ACAO.md`)

## Contexto
Sob o contrato mínimo (ADR-003), o Sistema B não possui flag de *soft delete* nem informa quem ou por que removeu um item. Quando um registro mapeado retorna 404 e desaparece da listagem do B, não há como saber automaticamente se foi uma exclusão intencional de um operador do B ou uma perda/wipe acidental no banco do B.

## Decisão
- **Exclusão em 2 passos (decisão humana):** quando o auditor confirma que o registro sumiu do B, o mapeamento entra no estado `deletion_requested`, uma proposta de exclusão é aberta e o chamado no A recebe uma nota informando honestamente *"Exclusão solicitada pelo B (autor/motivo não informado pelo B)"*.
- Enquanto a decisão estiver pendente, novas atualizações do A para esse chamado ficam **retidas na fila**, sem tentar escrever no registro ausente.
- **Se o Técnico aprovar:** o chamado no A é **fechado (status 6, nunca excluído fisicamente)** para preservar o histórico e a auditoria, e o mapeamento passa para `archived`.
- **Se o Técnico recusar:** o sincronizador verifica a listagem do B (procurando o marcador `⟦s:glpi-<id>⟧` para não duplicar), **recria** o registro no B, registra o ID antigo em `b_record_history[]`, atualiza `b_record_id` e entrega todas as atualizações que estavam retidas.
- No sentido inverso (ação iniciada no A), qualquer encerramento/exclusão exige motivo obrigatório e identificação do usuário.

## Consequências
- **Fica mais fácil:** evitar tanto a perda destrutiva no A quanto a recriação cega de um item que o operador do B realmente queria descartar; manter rastreabilidade completa de IDs antigos em `b_record_history[]`.
- **Fica mais difícil:** atualizações do chamado ficam retidas até a decisão do Técnico; exige tela/ação de aprovação ou recusa.
- **Risco que sobra:** demora na decisão humana manter o registro ausente no B por mais tempo (visível no dashboard).

## Alternativas consideradas
| Alternativa | Por que não |
|---|---|
| Propagar a exclusão automaticamente apagando o chamado no A | Um bug ou wipe no Sistema B não confiável apagaria dados oficiais na fonte da verdade (violação direta da proibição #2). |
| Recriar sempre automaticamente assim que sumir do B | Impediria qualquer exclusão legítima feita no B, recriando o registro indefinidamente sem consultar o Técnico. |
| Ignorar o sumiço e parar de sincronizar | Deixa o chamado inconsistente em silêncio e perde todas as atualizações seguintes. |

## Onde está no código / como provar
- Garantias **Nenhuma atualização perdida** e **Nenhum chamado/nota duplicado** (seção 5 do plano).
- Coluna `b_record_history[]` e estado `deletion_requested` em `ticket_mapping` (seção 8 do plano).
- Cenários A10 (recriação após exclusão recusada sem duplicar), B8 (updates retidos durante exclusão pendente) e D6 (exclusão aprovada/recusada).
