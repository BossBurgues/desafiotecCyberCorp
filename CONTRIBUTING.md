# Como contribuir

## Branches

| Branch | Papel |
|---|---|
| `Prod` | Produção (URL entregue). Recebe só PRs de release vindos da `Dev`. Deploy com aprovação manual |
| `Dev` | Integração e homologação (branch padrão). Recebe PRs das branches de milestone. Deploy automático em `dev.<host>` |
| `milestone/M<n>-slug` | Uma por milestone, criada a partir da `Dev`. No máximo 3 ativas ao mesmo tempo |

Branches de milestone: `milestone/M0-fundacao`, `milestone/M1-nucleo-a-b`, `milestone/M2-auditoria-seguranca`, `milestone/M3-b-a-propostas`, `milestone/M4-notas-mocks`, `milestone/M5-entrega`.

## Fluxo de cada atualização

1. **Escolha a próxima issue desbloqueada do milestone** no [Project](https://github.com/users/BossBurgues/projects/2), pela prioridade. Ela só começa quando todas as issues em *blocked by* estiverem fechadas.
2. Na branch do milestone, faça **commits pequenos**, um conceito por commit, com `Refs #<nº>`.
3. **Push** da branch.
4. **Abra um PR para a `Dev`** com `Closes #<nº>` e preencha o template. Um PR aberto por vez em cada branch.
5. **Rodada de QA** (ver abaixo), registrada na seção QA do PR, com o comentário final `QA ✅`.
6. **Merge (merge commit, sem squash) só com a CI verde e o QA ✅** → deploy automático em homologação. Issues de runtime têm QA pós-merge em `dev.<host>`.
7. `git pull origin Dev` na branch do milestone e siga para a próxima issue.
8. Milestone concluído → QA de release → **PR de release `Dev` → `Prod`** (`release: M<n> …`) → aprovação → deploy em produção.

## Rodada de QA

Toda issue passa por QA antes do merge (detalhes na seção 14.3 do [plano](docs/PLANO_DE_ACAO.md)):

1. **Critérios de aceite**, um a um, com evidência (comando + saída, run da CI ou captura).
2. **Caminho feliz** do "Como testar".
3. **Testes negativos**: o que deve ser bloqueado ou rejeitado de fato é.
4. **Validações temporárias** quando o comportamento só aparece no GitHub/CI: PR rascunho de `test/qa-<nº>-<slug>`, título `test(qa): …`, fechado sem merge e com a branch apagada.
5. **Regressão**: CI verde e cenários do catálogo ligados à issue.
6. **Prova de que o teste testa**: desligar o mecanismo e ver o teste falhar (issues que protegem uma garantia).
7. **QA pós-merge** na homologação (issues de runtime).

Se falhar: corrigir no mesmo PR e repetir, ou abrir uma issue `[bug]`. O tamanho da rodada acompanha a issue (docs < infra < código).

## CI

- O workflow [`.github/workflows/ci.yml`](.github/workflows/ci.yml) roda em PRs para `Dev` ou `Prod` e em push nas branches `milestone/**`.
- Só os apps alterados (`system-a`, `system-b`, `sync-service`) rodam; mexer em `contracts/` ou no `ci.yml` roda todos.
- `ci-ok` é a verificação obrigatória nas proteções; ela resume o resultado dos outros jobs.
- PR para a `Prod` só é aceito a partir da `Dev` (job `prod-source-guard`).
- Proteções: `Dev` e `Prod` não aceitam push direto e exigem `ci-ok` verde e merge commit; a `Dev` também exige a branch atualizada.

## Conventional Commits

```
<tipo>(<escopo>): <descrição no imperativo>
```

| Tipo | Uso |
|---|---|
| `feat` | Funcionalidade nova |
| `fix` | Correção |
| `test` | Testes |
| `docs` | Documentação |
| `refactor` | Mudança sem alterar o comportamento |
| `chore` | Build, CI, configuração |

Escopos: `system-a`, `system-b`, `sync`, `contracts`, `e2e`, `infra`, `docs`.

Exemplo: `feat(sync): grava marcador ⟦s:glpi-id⟧ ao criar registro no B`

## Definition of Done

- [ ] Rodada de QA registrada no PR (`QA ✅`)
- [ ] Testes passando
- [ ] CI verde
- [ ] `docs/how-it-works.md` atualizado se o fluxo mudou
- [ ] PR explica o que foi feito, por quê, como testar e qual garantia protege
- [ ] Horas registradas em [`docs/timelog.md`](docs/timelog.md)

## Regras de código

- **Comentários explicam o *porquê*, não o *quê*.**
- O domínio do sync (`apps/sync-service/src/domain`) é **puro**: sem I/O.
- **Nomes de testes são frases** que descrevem o comportamento.
- Nenhuma decisão do [plano](docs/PLANO_DE_ACAO.md) muda sem um **ADR** novo em `docs/adr/`.
- Segredos **nunca** vão para o repositório: use `.env` (ignorado) e mantenha o `.env.example` atualizado.
