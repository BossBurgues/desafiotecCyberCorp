# ADR-003: Contrato mínimo do B: a única suposição

- **Status:** Aceito
- **Data:** 16/10/2026
- **Decisões do plano:** Q3, Q8 (seção 2 e seção 7 do `PLANO_DE_ACAO.md`)

## Contexto
O enunciado define o Sistema B como uma API externa em outro formato e **não confiável** (caixa-preta). Assumir conveniências modernas no Sistema B — como chave de idempotência, busca por ID externo, webhooks ou relógio sincronizado — esconderia os problemas reais do desafio sob facilidades inventadas no próprio mock.

## Decisão
- Assumir do Sistema B **apenas o contrato mínimo**:
  1. Criar registro (`create`);
  2. Ler registro por ID (`read`);
  3. Atualizar registro por ID (`update`);
  4. Listar registros com paginação (`list`, sem garantia de consistência imediata);
  5. Preservar e devolver um campo de texto livre exatamente como foi gravado.
- **Não assumir:** busca por referência externa, cabeçalho `Idempotency-Key`, webhooks de saída, timestamps confiáveis, identificação obrigatória de autor, flag de excluído (soft delete), paginação estável ou códigos HTTP sempre coerentes.
- Tratar suporte a comentários (`B_SUPPORTS_COMMENTS`), autor da alteração (`updatedBy`) e controle otimista (`ETag` / `If-Match`) como **capacidades opcionais** configuradas ou detectadas em tempo de execução.
- O mock em `apps/system-b` não implementa nada além desse contrato mínimo (e do endpoint opcional de comentários), provando que o sincronizador não usa atalhos.

## Consequências
- **Fica mais fácil:** integrar com qualquer sistema legado ou de terceiro que ofereça ao menos um CRUD básico; demonstrar honestidade técnica na avaliação.
- **Fica mais difícil:** toda a responsabilidade de idempotência, detecção de perdas e reconciliação recai sobre o `sync-service` (marcador no texto, verificação pós-escrita e varreduras periódicas).
- **Risco que sobra:** se o Sistema B corromper ou truncar até mesmo o campo de texto livre, a reconciliação automática deixa de ser segura (tratado pelo teste de capacidade no ADR-004).

## Alternativas consideradas
| Alternativa | Por que não |
|---|---|
| Assumir `Idempotency-Key` ou busca por `externalId` no B | Elimina artificialmente o problema de duplicação em timeouts de criação, que é um dos pontos centrais da avaliação. |
| Exigir que o Sistema B envie webhooks para o Sync | Contradiz a premissa de caixa-preta instável e está fora do escopo (seção 13 do plano). |

## Onde está no código / como provar
- Especificação em `contracts/system-b.openapi.yaml` e implementação restrita em `apps/system-b`.
- Issues com a label `area:blackbox` e cenários das categorias A (duplicatas) e E (B hostil) na seção 12 do plano.
