# Como contribuir

## Fluxo

1. **Escolha uma issue desbloqueada** no [Project](https://github.com/users/BossBurgues/projects/2). Ela só pode começar quando todas as issues em *blocked by* estiverem fechadas.
2. **Crie uma branch** a partir da `main`:
   - `feat/<nº>-slug` para funcionalidade
   - `fix/<nº>-slug` para correção
   - `test/<nº>-slug` para cenário de teste
   - `docs/<nº>-slug` para documentação
   - `chore/<nº>-slug` para infra e configuração
3. **Commits pequenos e frequentes**, um conceito por commit.
4. **Abra um PR** com `Closes #<nº>` e preencha o template.
5. **Merge só com a CI verde.** A `main` está sempre pronta para deploy.

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
