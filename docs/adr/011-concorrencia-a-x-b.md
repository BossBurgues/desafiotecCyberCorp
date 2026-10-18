# ADR-011: Concorrência A×B: o A vence, ler antes de escrever, If-Match opcional, risco residual

- **Status:** Aceito (aplica-se ao fluxo B→A — M3, opcional)
- **Data:** 16/10/2026
- **Decisões do plano:** Q4, Q7, Q18, Q19 (seções 2 e 5.2 do `PLANO_DE_ACAO.md`)

## Contexto
Quando o fluxo B → A está ativo, responde diretamente à **pergunta (2) do avaliador**: *o que acontece quando o Sistema A e o Sistema B alteram o mesmo chamado ao mesmo tempo?* Como o Sistema B não faz parte do nosso domínio e o seu contrato mínimo (ADR-003) não garante transações distribuídas nem controle otimista de versão obrigatório, uma escrita do sincronizador poderia sobrescrever em silêncio algo acabado de ser alterado no B.

## Decisão
- **Regra geral:** o Sistema A é a fonte da verdade, mas **nenhuma alteração feita no B desaparece sem registro**.
- **Resolução por tipo de conflito (seção 5.2):**
  - *Mesmo campo alterado nos dois lados (ex.: prioridade):* o valor do A vence e é gravado no B; a tentativa do B vira nota no A (*"B alterou X para Y às …; prevaleceu o valor do A"*).
  - *O A muda o status enquanto o B propõe "resolvido":* a proposta nasce ou vira **obsoleta** (`based_on_hash` diferente do estado atual) + nota no A para o Técnico ver ambos os fatos.
  - *Campos diferentes (ex.: o A muda a prioridade e o B resolve):* as duas mudanças são preservadas — a prioridade do A é entregue ao B e a resolução do B vira proposta no A (exceto o campo em proposta, que não é sobrescrito).
- **Ler antes de escrever (`GET` antes do `PUT`):** imediatamente antes de atualizar um registro no B, o worker faz `GET` no B. Se o hash atual do B divergir de `last_written_hash`, o sincronizador classifica e registra a mudança do B **antes** de aplicar o `PUT`.
- **`If-Match` opcional:** se o Sistema B devolver cabeçalho `ETag` no `GET`, o `PUT` envia `If-Match`; em caso de `412 Precondition Failed`, o worker relê o B e reprocessa a classificação antes de escrever.
- **"Quem alterou" no B:** registrado na nota se o B fornecer a capacidade opcional `updatedBy`; caso contrário, a nota informa honestamente *"autor não informado pelo B"*.

## Consequências
- **Fica mais fácil:** garantir que nenhuma ação concorrente do Operador B suma sem rastro na conversa do chamado e no `audit_log`.
- **Fica mais difícil:** cada `PUT` no B é precedido por um `GET` de leitura prévia.
- **Risco que sobra (risco residual explícito):** quando o Sistema B **não** oferece `ETag` / `If-Match`, resta uma janela inevitável de poucos milissegundos entre o `GET` e o `PUT` em que uma escrita concorrente no B pode ser sobrescrita sem detecção prévia — é teoricamente impossível eliminar 100% dessa janela sem primitiva de concorrência no próprio B. Se o B rejeitar ou alterar o estado logo depois, a verificação pós-escrita e a varredura seguinte detectam a divergência de hash.

## Alternativas consideradas
| Alternativa | Por que não |
|---|---|
| Último a escrever vence (*Last-Write-Wins*) | Apaga silenciosamente alterações do A ou do B dependendo apenas de quem chegou por último. |
| O Sistema B vence em caso de empate | Viola a regra de negócio de que o Sistema A é a fonte da verdade (ADR-006). |
| Lock distribuído entre A e B | Impossível sob o contrato mínimo de caixa-preta do Sistema B (ADR-003). |

## Onde está no código / como provar
- Seção 5.2 do plano, `apps/sync-service/src/application/` (`processJob` + `detectBChanges`).
- Cenários **C7** (A e B no mesmo campo ao mesmo tempo), **C8** (campos diferentes ao mesmo tempo), **C9** (B edita durante a escrita do sync), **D9** (autor da alteração no B) e **F4** (ping-pong A↔B).
