# ADR-013: O PDF é a base; o A é o sistema central e o B só recebe

- **Status:** Aceito
- **Data:** 19/10/2026
- **Decisões do plano:** Q4/Q7, Q26, Q17/Q18/Q27 (seções 0.5, 2 e 6 do `PLANO_DE_ACAO.md`)

## Contexto
O plano de 16/10 desenhou os dois sentidos: o B **executa** (resolve, fecha, reabre, exclui) e o A **aprova** (ADR-006). Por isso a UI do B ganhou essas ações e o A não podia solucionar nem fechar: o 5/6 só chegaria por aprovação.

Em 18/10 o B → A saiu do escopo (o avaliador confirmou que é opcional), mas o corte foi feito no plano e nas issues, não nas UIs nem nos READMEs. Na revisão de 19/10 contra o PDF, o resultado parecia o contrário do enunciado: o B como sistema de trabalho e o A como coadjuvante.

O PDF diz: o A é "o nosso sistema de chamados" (referência GLPI), onde o chamado é criado e atualizado. O B é outro sistema, com outra API e outro formato, não confiável, que precisa receber e ficar atualizado.

## Decisão
- **O PDF é a régua.** Em conflito com o plano, as issues ou o e-mail, vale o PDF. O esclarecimento do avaliador (B → A opcional, com anti-eco e concorrência) continua valendo como extensão opcional.
- **O A é o central:** o Técnico cria, edita, soluciona (5) e fecha (6), como no GLPI. O sync leva `RESOLVED`/`CLOSED` ao B como qualquer outra atualização.
- **O B só recebe.** Ele tem um operador próprio (é um sistema de terceiro), mas o que o operador faz não volta ao A e é sobrescrito na próxima alteração do A. A UI do B avisa isso.
- O ADR-006 (o B propõe, o A aprova, congelamento) e o ADR-007 (exclusão em 2 passos) passam a valer **só** para o B → A opcional.

## Consequências
- A demo mostra o fluxo do PDF: abrir, editar, solucionar e fechar no A e ver tudo chegar ao B.
- Risco conhecido enquanto o B → A não existir: se o operador do B fechar um chamado e o A for editado depois, o sync reabre o chamado no B (o A vence). Fica documentado e é o primeiro caso a resolver se o B → A voltar (ler antes de escrever, ADR-011).
- Se o B → A for implementado depois, o 5 vindo do B volta a ser "aguardando aprovação" e o congelamento passa a valer; o Técnico continua podendo solucionar e fechar direto no A.

## Alternativas consideradas
| Alternativa | Por que não |
|---|---|
| Manter o A sem 5/6 (só via aprovação) | Sem o B → A, não haveria como fechar um chamado, e fechar é a atualização mais comum |
| Inverter os papéis (o B como central) | Contraria o PDF |
| Tirar as ações da UI do B | Possível, mas o B é um sistema de terceiro com operador próprio; o aviso explica o comportamento, e as ações serão úteis se o B → A voltar |

## Onde está no código / como provar
- `apps/system-a/src/public/ui-core.js` (`editableStatuses` 1–6) · teste "o Técnico pode escolher todos os status do GLPI…"
- `apps/system-a/test/integration/auth-api.test.js` · "Técnico soluciona e depois fecha o chamado (status 5 e 6)…"
- `apps/sync-service/test/integration/process-job.test.ts` · "chamado solucionado e depois fechado no A chega ao B como RESOLVED e CLOSED…"
- PR #172; `docs/PLANO_DE_ACAO.md` seção 0.5
