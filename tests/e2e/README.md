# Testes E2E

Cenários do núcleo A→B (seção 12 do [plano](../../docs/PLANO_DE_ACAO.md)) executados contra o `docker compose` completo, com o caos do B ligado. Um arquivo por cenário, com nome autoexplicativo. Rodam em todo PR (job `e2e` da CI, obrigatório no `ci-ok`).

## Como rodar

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.e2e.yml --env-file .env.example up -d --build --wait
npm run e2e          # ~3 min, cenários em sequência
docker compose -f infra/docker-compose.yml -f infra/docker-compose.e2e.yml --env-file .env.example down -v
```

Os cenários falam direto com as portas locais (A `3001`, B `5002`, sync `3000`), mexem no caos pelo dashboard do sync (login fixo do E2E) e derrubam containers com `docker compose`.

## O que cada cenário prova

A asserção central é `expectSyncedOnce`: cada chamado aparece **exatamente uma vez** no B (pelo marcador `⟦s:glpi-<id>⟧`) e com o **título mais novo** do A. Uma duplicata, mesmo de passagem, falha na hora.

| Arquivo | Cenário | Prova |
|---|---|---|
| `00-nucleo-a-b-sob-caos` | caos agressivo (seed 42) | 20 criados e 5 editados chegam uma vez, atualizados |
| `a1-commit-then-fail-nao-duplica` | A1 | B grava e responde 500 → o retry acha o marcador e adota |
| `a2-timeout-gravacao-tardia-nao-duplica` | A2 | B grava depois do timeout do sync → sem recriar às cegas |
| `b1-b-fora-jobs-esperam-e-drenam` | B1 | B parado 30 s → jobs esperam, drenam na volta, DLQ vazia |
| `b2-webhook-perdido-poller-recupera` | B2 | A sem nenhum webhook → o poller traz tudo |
| `b3-sync-cai-no-meio-do-job` | B3 | sync morto (SIGKILL) com job rodando → lease vence, sem duplicar |
| `b6-vinte-updates-terminam-no-ultimo` | B6 | 20 edições seguidas → o B termina na 20ª |
| `c1-eventos-fora-de-ordem` | C1 | evento velho reentregue depois do novo → o B fica no novo (ADR-005) |
| `e4-b-lento-disjuntor` | E4 | B com 10 s de latência → disjuntor abre, tudo sincroniza na volta |
| `g1-conversao-de-campos-do-glpi` | G1 | Categoria, local, requerente e técnico do A chegam como texto no B; solucionar e fechar viram `RESOLVED` e `CLOSED` |

Cobertos por testes de integração do sync (sem E2E): A4 e H1 (`inbound.test.ts`), A6, B10 e G4 (`scenarios.test.ts`), H2 (`dashboard.test.ts`).

Issues: épico **E8**.
