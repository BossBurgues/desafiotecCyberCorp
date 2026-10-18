# ADR-006: O B propõe, o A aprova; status 5 e congelamento × SLA

- **Status:** Aceito (aplica-se ao fluxo B→A — M3, opcional)
- **Data:** 16/10/2026
- **Decisões do plano:** Q4, Q7, Q17–Q19, Q26–Q29 (seções 2, 4, 5 e 6 do `PLANO_DE_ACAO.md`)

## Contexto
O retorno B → A é opcional no desafio. Quando habilitado, o Sistema A permanece como fonte da verdade e controla o SLA oficial, enquanto o Sistema B é uma caixa-preta não confiável. Aceitar alterações do B diretamente no A permitiria que um sistema externo fechasse chamados ou sobrescrevesse campos sem validação.

## Decisão
- **O B propõe, o A aprova:** toda alteração detectada no B é classificada (Q19):
  - Resolver, excluir ou reabrir → vira **proposta** (`proposals`) aguardando decisão de um Técnico no A;
  - Comentário → vira **nota** na conversa do chamado no A (mesmo pós-fechamento, sem reabrir);
  - Outros status intermediários → apenas registro **informativo**;
  - Edição direta de campo (ex.: título, prioridade) → **revertida no B** para o valor do A + nota no A registrando a tentativa.
- **Fidelidade ao GLPI e SLA:** proposta de solução cria `ITILSolution` pendente, muda o chamado para **status 5 (Solucionado)** e grava `solvedate` com o horário UTC da detecção (pausando o SLA). Se o Técnico aprovar → **status 6 (Fechado)**; se recusar → volta para **status 2 (Em atendimento)**, reverte o B e registra o motivo nos dois lados.
- **Congelamento:** nos status 5 e 6 o chamado fica imutável para edições de campos (retorna **409 Conflict** explícito + `audit_log`), aceitando apenas notas e a decisão da proposta.
- **Congelamento × perda (Q28):** o congelamento bloqueia **escritas novas** no A, mas **nunca barra a entrega ao B** de alterações que o A já havia aceitado antes de congelar (exceto o próprio campo em proposta).
- Cada proposta guarda `based_on_hash`; se o A já alterou o campo correspondente, a proposta nasce ou vira **obsoleta (`superseded`)**.

## Consequências
- **Fica mais fácil:** proteger a autoridade do Sistema A e o cálculo de SLA; garantir que nenhuma ação do B desapareça silenciosamente.
- **Fica mais difícil:** exige intervenção humana (Técnico) para concluir transições propostas pelo B e adiciona máquina de estados de propostas e congelamento.
- **Risco que sobra:** acúmulo de propostas pendentes se a operação não acompanhar a fila de aprovação (visível na UI do A e no dashboard).

## Alternativas consideradas
| Alternativa | Por que não |
|---|---|
| Sincronização bidirecional "último a escrever vence" | Permite que o Sistema B não confiável sobrescreva dados oficiais e manipule o SLA do A. |
| Ignorar silenciosamente qualquer mudança feita no B | O operador do B acharia que resolveu o chamado enquanto o A continuaria aberto sem visibilidade. |
| Criar um status customizado fora do padrão GLPI | Descaracteriza o ciclo de vida nativo do GLPI (1 Novo → 2 Em atendimento → 5 Solucionado → 6 Fechado). |

## Onde está no código / como provar
- Épico M3 (`milestone/M3-b-a-propostas`), issues com label `area:approval`.
- Cenários B7 (update na fila + congelamento), C3 (proposta sobre versão antiga), C4 (duas propostas seguidas), C5 (edição de campo revertida) e D1 a D8 (seção 12 do plano).
