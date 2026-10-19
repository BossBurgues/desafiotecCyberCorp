# ADR-012: Repositório e CI só no GitHub, sem mirror no GitLab

- **Status:** Aceito
- **Data:** 18/10/2026
- **Decisões do plano:** CI/CD (seção 2 do `PLANO_DE_ACAO.md`); issue S4.5 (#43)

## Contexto
O plano previa o GitHub Actions como CI principal e um **mirror no GitLab** (S4.5), supondo que o avaliador preferisse encontrar o projeto lá. Ao conferir o enunciado, a tabela de ferramentas sugeridas oferece "GitHub + GitHub Actions, **ou** GitLab + GitLab CI": as plataformas são alternativas, não as duas. Além disso, o *pull mirror* e os tokens de projeto do GitLab são recursos do plano Premium, e o desafio pede que tudo seja feito sem gastar nada.

## Decisão
- O repositório, as issues, o Project e a CI ficam **só no GitHub**.
- Não há mirror no GitLab nem em outra plataforma. A S4.5 (#43) é encerrada como *not planned*.
- O item entra em `docs/out-of-scope.md` com o "como eu faria".

## Consequências
- **Fica mais fácil:** uma única fonte para código, histórico, CI e backlog; nada de credencial a mais para guardar e rotacionar; uma hora devolvida ao caminho crítico do M1.
- **Fica mais difícil:** quem quiser ver o projeto no GitLab não encontra uma cópia lá.
- **Risco que sobra:** nenhum para a entrega. O enunciado aceita o GitHub e a entrega é o link do repositório.

## Alternativas consideradas
| Alternativa | Por que não |
|---|---|
| Pull mirror no GitLab | Recurso do plano Premium |
| Push mirror a partir do GitHub Actions (deploy key SSH com escrita) | Pelo que sabemos, funcionaria no plano grátis (não verificado), mas mantém uma segunda cópia que o enunciado não pede |
| Mirror em outra plataforma (Codeberg, Bitbucket) | Não atende a nenhuma preferência do avaliador e só adiciona manutenção |

## Onde está no código / como provar
- `docs/out-of-scope.md`, linha "Mirror no GitLab".
- Seção 2 do `PLANO_DE_ACAO.md`, linha CI/CD.
- Issue #43 encerrada como *not planned*.
