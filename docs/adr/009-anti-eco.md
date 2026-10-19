# ADR-009: Anti-eco (`last_written_hash`, `sync-bot`)

- **Status:** Aceito · implementado no B → A leve (ADR-014)
- **Data:** 16/10/2026
- **Decisões do plano:** Q22 (seções 2 e 5.1 do `PLANO_DE_ACAO.md`)

## Contexto
Quando o retorno B → A está ativo, o sincronizador lê e escreve nos dois sistemas. Isso responde diretamente à **pergunta (1) do avaliador**: *como evitar que uma atualização fique indo e voltando em loop (ping-pong) entre A e B?* Sob o contrato mínimo (ADR-003), não podemos assumir um campo customizado `source=sync` no Sistema B nem confiar no relógio dele.

## Decisão
Combinar quatro barreiras complementares de anti-eco:
1. **`last_written_hash` por registro do B:** toda vez que o sincronizador escreve no Sistema B (e confirma na verificação pós-escrita), salva o hash canônico do estado gravado em `ticket_mapping.last_written_hash`. Quando o auditor varre o B e encontra um hash igual a `last_written_hash`, sabe que está vendo a própria escrita e **não** trata como mudança do B.
2. **Filtro de ator `sync-bot` no A:** notas de sistema e transições aplicadas pelo usuário técnico `sync-bot` no Sistema A não geram novos jobs A → B (e são ignoradas pelo receptor de webhook/poller).
3. **Hash do A ignora `date_mod`:** adicionar uma nota técnica no chamado do A atualiza `date_mod`, mas não altera o hash dos campos sincronizáveis; logo, `last_synced_hash` continua igual e não dispara `PUT` desnecessário no B.
4. **Convergência em passo único:** aprovar ou recusar uma proposta executa exatamente **uma** escrita de confirmação/reversão em cada lado, atualiza `last_synced_hash` e `last_written_hash` na mesma conclusão e estabiliza.

## Consequências
- **Fica mais fácil:** provar matematicamente e em teste que qualquer alteração converge em um número finito e pequeno de escritas, sem depender de janelas de tempo frágeis.
- **Fica mais difícil:** exige que a função de normalização e hash de ambos os lados seja estritamente determinística (trim, ordem de chaves, quebras de linha).
- **Risco que sobra:** o Sistema B reformata ou altera um campo ao salvar (detectado já na verificação pós-escrita logo após o `PUT`, atualizando `last_written_hash` com o valor normalizado devolvido).

## Alternativas consideradas
| Alternativa | Por que não |
|---|---|
| Ignorar mudanças do B por `N` segundos após cada escrita | Frágil: se a varredura atrasar além da janela dá falso positivo; se um operador editar dentro da janela, a mudança real é perdida. |
| Criar um campo `updatedBy = sync` no Sistema B | Não está garantido no contrato mínimo do Sistema B (ADR-003). |
| Comparar timestamps de modificação entre A e B | O relógio do B não é confiável (ADR-005). |

## Onde está no código / como provar
- Seção 5.1 do plano, `apps/sync-service/src/domain/` (hash canônico) e `apps/sync-service/src/application/` (`detectBChanges`).
- Cenários **F1** (estabilização em 3 ciclos), **F2** (nota do `sync-bot` não dispara sync), **F3** (escrita própria não vira mudança do B) e **F4** (ping-pong A↔B com contador de escritas estável).
