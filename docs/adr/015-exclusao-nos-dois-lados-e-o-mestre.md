# ADR-015: Exclusão nos dois lados (lixeira do A e lápide do B) e quem é o mestre em cada mudança

- **Status:** Aceito
- **Data:** 19/10/2026
- **Decisões do plano:** seções 2.4 e 2.5 do `Docs/PlanosDeAcao/plano-final-a-central-e-entrega.md`
- **Relaciona:** substitui o ADR-007 (exclusão em 2 passos, que ficou só como desenho). Complementa o ADR-013 (o A é o central) e o ADR-014 (B → A leve)

## Contexto
Em 19/10, na produção: um chamado criado no A e excluído pela UI do operador do B **não chegava ao A**. O mapeamento continuava `active` e não havia nem job nem auditoria. A varredura do B (ADR-014) só compara os registros que **aparecem** na listagem; um registro excluído some dela e nunca era comparado. Pior: na próxima edição do chamado no A, o update leria o B, receberia 404 e recriaria o registro (S3.8), desfazendo a exclusão sem avisar ninguém.

O ADR-007 não ajudava: sob o contrato mínimo (ADR-003), o B não diz se um registro foi excluído por alguém ou perdido. Por isso ele pedia uma decisão humana em 2 passos, cara demais para o prazo.

O avaliador quer ver, para cada tipo de mudança, **quem manda** e o que acontece quando os dois lados mexem.

## Decisão
**O B ganha uma lápide (capacidade opcional `tombstone` + `delete`).** Excluir um registro, pela UI do operador ou pela API (`DELETE /api/v2/records/{id}`), deixa `deleted_at` e `deleted_by`. O registro some da leitura e da listagem; `GET`, `PUT` e um novo `DELETE` respondem **410** com `deletedBy` e `deletedAt`. Um registro que nunca existiu ou que o B perdeu continua **404** (o admin do B ainda simula essa perda, sem lápide). Assim o sync distingue os dois casos sem perguntar a ninguém: **410 = excluído por alguém, 404 = perdido**.

**O A ganha a lixeira do GLPI.** `DELETE /Ticket/:id` marca `is_deleted = 1` (como o `DELETE` sem `force_purge` da API do GLPI); `PUT {is_deleted: 0}` restaura. A listagem padrão mostra só os ativos; `is_deleted=1` lista a lixeira. Na lixeira o chamado só aceita restaurar (409). O `sync-bot` pode mexer em `status` e `is_deleted`, e em nada mais.

### Quem é o mestre em cada mudança
| Mudança | Onde nasce | Mestre | O que o sync faz |
|---|---|---|---|
| Criar | A | A | Cria no B com o marcador. Registro criado no B sem marcador é ignorado |
| Campos (título, descrição, prioridade, categoria, local, requerente, técnico) | A | **A** | Leva ao B. Edição desses campos no B é desfeita, com nota no A (ADR-014) |
| Status | A ou B | Quem mudou desde a última sincronização; os dois mudaram → **o A** | Só o A → B recebe. Só o B → A recebe, com nota de quem e da solução. Os dois → o A vence, com nota (ADR-014) |
| Quem alterou / solução | B | B (é informação do B) | Nota no A |
| **Excluir no A** | A | **A** | `DELETE` no B (lápide da integração) e mapeamento `archived`. **Restaurar** recria no B; o ID antigo vai para `b_record_history` |
| **Excluir no B** | B | **o A decide** | O chamado vai para a **lixeira do A** (reversível), com a nota "Excluído no Sistema B por *quem* em *quando*", e o mapeamento vira `archived`. Se o A mudou o chamado depois da última sincronização, **o A vence**: recria no B e registra a nota |
| Registro some do B sem exclusão (404) | — | A | Procura o marcador; senão recria (S3.8) |

### Como o sync percebe a exclusão no B
1. A varredura percorre a listagem inteira. Todo registro mapeado que **não apareceu** é suspeito.
2. Como a listagem do B pode pular página (A7/E6), o suspeito é **confirmado por `GET`**: 200 → foi a paginação, nada a fazer; 410 ou 404 → job `b_changed`.
3. O job relê o B (ler antes de escrever) e decide pela tabela acima.

### Anti-eco
- A lixeira feita pelo `sync-bot` não dispara webhook (ADR-009).
- O mapeamento arquivado guarda o hash do chamado **já na lixeira**; o poller (que agora lê as duas listas, ativos e lixeira) o vê como sincronizado e não enfileira nada.
- O hash do chamado só inclui `is_deleted` quando ele é 1: os hashes dos chamados que nunca foram excluídos não mudam.
- Exclusão no A e no B ao mesmo tempo: o `DELETE` do sync recebe 410 e conta como feito.

## Consequências
- **Fica mais fácil:** responder "quem manda" para cada mudança; excluir é reversível nos dois sentidos (a lixeira do A guarda tudo, inclusive a conversa); o bug de 19/10 tem teste que o reproduz.
- **Fica mais difícil:** o B precisa da capacidade `tombstone`. Um B sem ela devolve 404 ao excluir, e o sync trata como perda (recria): o A continua mestre, só sem a lixeira automática.
- **Risco que sobra:** a varredura precisa de uma listagem completa para suspeitar de um registro; com a listagem do B atrasada ou instável, a exclusão é percebida alguns ciclos depois (30 s cada). Um registro excluído no B logo antes de o A mudar o chamado é recriado (o A vence), o que é a regra, mas pode surpreender o operador do B: a nota no A registra o caso.
- **Quem pode excluir:** excluir no B leva o chamado para a lixeira do A, então a conta do operador do B é uma porta para o A. Na URL pública, criar conta no B exige o código de convite (`B_OPERATOR_INVITE_CODE`), a sessão expira em 12 h e o login tem limite de tentativas; no A, o cadastro pela tela cria só Estagiário (Técnico com `A_SELF_REGISTER_TECNICO=true`, uso local). O `sync-bot` manda para a lixeira, mas não restaura: restaurar é decisão de um Técnico.

## Alternativas consideradas
| Alternativa | Por que não |
|---|---|
| Exclusão em 2 passos com aprovação do Técnico (ADR-007) | Exige proposta, tela de decisão e fila retida; não cabia no prazo, e a lixeira do A já é reversível sem pedir nada a ninguém |
| Apagar o chamado no A quando some do B | Um wipe no B apagaria dados da fonte da verdade (proibição #2 do PDF) |
| Recriar sempre (comportamento antigo, S3.8) | Desfaz a exclusão do operador sem avisar ninguém: era o bug |
| Fechar o chamado no A em vez de mandar para a lixeira | Fechar é uma decisão de atendimento, não de exclusão; restaurar da lixeira é o caminho natural do GLPI |

## Onde está no código / como provar
- B: `SqliteRecordStore.Delete`/`GetTombstone`/`Purge`, `RecordsEndpoints.Delete`, `ErrorResults.Missing`; testes `OperatorDeleteTests`, `SqliteRecordStoreTests`.
- A: `DELETE /Ticket/:id`, `is_deleted` em `store.js`/`tickets.js`; testes `trash-api.test.js`.
- Sync: `scanOnce` (suspeitos confirmados por GET), `trashInB`, `deletedInB` e `archive` em `process-job.ts`; poller com as duas listas; testes `deletion.test.ts` (o primeiro reproduz o bug de 19/10).
- E2E: `h1-exclusao-nos-dois-lados` (excluir no A, restaurar, excluir no B, sem eco).
