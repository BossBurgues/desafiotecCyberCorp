# ADR-014: B → A leve: o estado mudado no B volta ao A, sem aprovação

- **Status:** Aceito
- **Data:** 19/10/2026
- **Decisões do plano:** Q4/Q7, Q19, Q22 (anti-eco), concorrência A × B (seções 0.6, 5.1 e 5.2 do `PLANO_DE_ACAO.md`)
- **Relaciona:** ADR-009 (anti-eco) e ADR-011 (concorrência), que ele implementa. Versão enxuta do ADR-006; o ADR-007 continua só como desenho. Complementa o ADR-013

## Contexto
O PDF pede só o A → B. O avaliador abriu um opcional: "o retorno de B para A (mudança de status, quem alterou, solução, fechamento e reabertura)". Se for feito, ele quer ver duas coisas: **como uma atualização não fica indo e voltando** entre os sistemas, e **o que acontece quando os dois alteram o mesmo chamado ao mesmo tempo**.

O desenho completo (ADR-006: proposta, aprovação do Técnico, congelamento a partir do 5, exclusão em 2 passos) não cabia até 22/10. A validação de 19/10 propôs uma versão leve, que responde às duas perguntas com código rodando e prova automatizada.

## Decisão
- **O que volta ao A:** o **estado** que o operador do B mudou (resolver → 5, fechar → 6, reabrir → 1, em espera → 4, em andamento → 2), com **quem alterou** (`updatedBy` do B) e a **solução** (`resolution` do B) numa nota do `sync-bot` na conversa do chamado. Sem aprovação: o A aceita o estado do B.
- **O que não volta:** edição de outros campos no B (título, descrição, severidade…). O A é a fonte da verdade e restaura o valor, com nota. Exclusão no B segue a S3.8 (procura o marcador e recria).
- **Detecção:** o B não avisa ninguém, então a **varredura do B** (`B_SCAN_INTERVAL_MS`, 30 s) compara cada registro mapeado com o `last_written_hash` (o hash do que o sync escreveu). Diferente → job `b_changed` na mesma fila, com o mesmo lease, retry e auditoria do A → B.
- **O que mudou, campo a campo:** o mapeamento guarda o `last_written_record` (o que o sync escreveu por último). Comparado com o registro atual do B, diz exatamente o que o B mudou.
- **Ler antes de escrever:** todo update do A → B relê o B antes do PUT. Assim, uma edição no A nunca reabre um chamado que o B acabou de fechar, mesmo antes da varredura.
- **Liga e desliga:** `B_TO_A_ENABLED` (ligado por padrão). Desligado, o sync volta ao núcleo A → B, mas ainda não desfaz o estado que o B mudou.

### Pergunta 1: como evitar a ida e volta (anti-eco)
1. **O que o sync escreveu não é mudança do B:** a varredura ignora registros com hash igual ao `last_written_hash`.
2. **O que o sync-bot escreveu no A não volta para o B:** o A não dispara webhook para o `sync-bot`. Quando o poller vê a mudança, o mapeamento já tem o hash novo do A, então o job vira no-op.
3. **Nenhuma escrita desnecessária no B:** se o B já está igual ao que o sync escreveria (o caso de "só o B mudou o estado"), não há PUT.
4. **A nota não duplica:** ela é escrita depois de o mapeamento ser gravado; se o job repetir, a mudança já foi registrada.

Prova: `b-to-a.test.ts`, "(1) sem ida e volta: depois de aplicar no A, três ciclos seguidos não escrevem nada em nenhum lado"; E2E `f4-b-fecha-volta-ao-a-sem-eco` (o `updatedAt` do B e o `date_mod` do A não mudam depois do fechamento).

### Pergunta 2: os dois alteram o mesmo chamado ao mesmo tempo
| Situação | Resultado |
|---|---|
| Só o B mudou o estado | Vale o do B: o A recebe o status e a nota |
| Os dois mudaram o estado | **O A vence** (é a fonte da verdade): o B é sobrescrito e o A ganha uma nota dizendo o que o B tinha feito e por quem |
| O B mudou outro campo | O A vence: o valor é restaurado no B, com nota no A |
| O A mudou outro campo e o B fechou | As duas coisas valem: o B continua fechado e recebe a edição; o A fica fechado |
| O B mudou entre o GET e o PUT do sync | **Risco residual**: o mock não tem ETag. Com `If-Match` o PUT receberia 412 e releria (ADR-011). A janela é de milissegundos e a próxima varredura corrige |

Prova: `b-to-a.test.ts`, "(2) A e B mudam o estado ao mesmo tempo: o A vence…", "o B edita o título…", "o A edita outro campo depois que o B fechou…".

## Consequências
- O B deixa de ser só um receptor: o operador dele resolve e fecha, e o A fica sabendo (ADR-013 continua valendo para todo o resto: o A é o central e a fonte da verdade).
- Uma requisição a mais por update (o GET antes do PUT) e uma listagem do B a cada 30 s. Aceitável no volume do desafio; a varredura é desligável.
- Sem aprovação, um estado errado no B chega ao A; o Técnico corrige no A, e o A vence daí em diante. Aprovação (ADR-006) é a evolução natural.

## Alternativas consideradas
| Alternativa | Por que não |
|---|---|
| B → A completo (ADR-006 e 007) | 2–3 dias; não cabia até 22/10 |
| Só desenho | Responde às perguntas sem prova rodando, e o risco "o A reabre o que o B fechou" ficaria aberto |
| Comparar pelo `updatedAt` do B | O relógio do B não é confiável (ADR-003, C6); o hash do conteúdo não depende dele |

## Onde está no código / como provar
- `apps/sync-service/src/application/b-scanner.ts` (varredura) · `process-job.ts` (`update` lê antes de escrever, `reconcile`) · migration `004_b_to_a.sql`
- `apps/system-a`: `POST /ITILFollowup`, `GET /Ticket/:id/ITILFollowup`, `sync-bot` só com o campo status
- `apps/system-b`: `updatedBy` (cabeçalho `X-Operator`), `resolution`, UI do operador com nome e solução
- Testes: `b-to-a.test.ts` (9), E2E `f4-b-fecha-volta-ao-a-sem-eco`
