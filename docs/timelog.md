# Registro de horas

Desafio recebido em **16/10/2026**. Entrega-alvo: **22/10/2026**.

| Data | Issue / atividade | Estimado (h) | Real (h) | Observações |
|---|---|---|---|---|
| 16/10 | Leitura do desafio, plano de ação e sessão de decisões (Q1–Q40) | — | _a preencher_ | Resultado: `docs/PLANO_DE_ACAO.md` |
| 16/10 | Backlog no GitHub: 133 issues, milestones, dependências, Project | — | _a preencher_ | |
| 16/10 | Resposta do avaliador: B→A opcional, anti-eco e concorrência | — | _a preencher_ | Seções 5.1 e 5.2 do plano |
| 18/10 | #12 [S0.1] Estrutura do monorepo | 2 | _a preencher_ | |
| 18/10 | #13 [S0.2] CI esqueleto + proteções | 1.5 | 0.5 | |
| 18/10 | #14 [S0.3] ADRs 001–011 | 2 | 0.5 | 11 ADRs (o 011 entrou após a resposta do avaliador) |
| 18/10 | #15 [S0.4] Contratos OpenAPI do A e do B + schema do evento | 2 | 0.5 | inclui QA |
| 18/10 | #16 [S1.1] API de chamados estilo GLPI | 3 | 0.5 | inclui QA |
| 18/10 | #17 [S1.2] Usuários e perfis: Técnico, Estagiário, sync-bot | 2 | 0.5 | inclui QA |
| 18/10 | #22 [S1.7] Testes e Dockerfile do Sistema A | 1.5 | 1 | inclui QA |
| 18/10 | #18 [S1.3] Webhook ticket.changed com HMAC e modo "perder X%" | 2 | 0.5 | inclui QA |
| 18/10 | #21 [S1.6] UI do Sistema A (login, lista, chamado, conversa, aprovações) | 3 | 0.5 | inclui QA |
| 18/10 | #30 [S3.2] Domínio puro: mapper A→B, hash, fuso | 3 | 0.5 | inclui QA |
| 18/10 | #23 [S2.1] API de records do B (contrato mínimo, formato próprio) | 3 | _a preencher_ | inclui QA |
| 18/10 | #28 [S2.6] Testes xUnit e Dockerfile do Sistema B | 1.5 | 0.25 | sprint M1; smoke + build amd64/arm64 na CI |
| 18/10 | #24 [S2.2] Middleware de caos configurável e reproduzível | 3 | 0.5 | sprint M1 |
| 18/10 | #26 [S2.4] UI do Operador B | 2.5 | 0.5 | sprint M1; "comentar" segue com a S2.3 (#25) |
| 18/10 | #29 [S3.1] Bootstrap do sync: config, logs, HTTP, health/ready, migrations | 3 | 0.5 | sprint M1 |
| 18/10 | #64 [S9.2] architecture.md com diagramas Mermaid | 2 | 0.5 | sprint M5; 8 diagramas validados no parser do Mermaid 11 |
| 18/10 | #67 [S9.5] out-of-scope.md | 1 | 0.25 | sprint M5 |
| 18/10 | #27 [S2.5] Admin do B: apagar registro, wipe, drift de formato | 1.5 | 0.5 | sprint M1 |
| 18/10 | #33 [S3.5] Adapter B: timeout, circuit breaker, validação de resposta | 3 | 0.75 | sprint M1 |
| 18/10 | #31 [S3.3] Fila: um job por chamado, SKIP LOCKED, lease, backoff, DLQ | 4 | 1 | sprint M1; `rerun` para evento que chega durante o processamento |
| 18/10 | #39 [S4.1] Docker Compose completo (local = produção) + override E2E | 2 | 0.75 | sprint M1; inclui o Dockerfile do sync |
| 18/10 | #34 [S3.6] processJob: create/update idempotente com marcador | 5 | 1 | sprint M1 (2); cliente do A como sync-bot, migration 003 |
| 18/10 | #32 [S3.4] Entrada: webhook HMAC + poller com sobreposição | 3 | 0.75 | sprint M1 (2); poller compara pelo hash (B12) |
| 18/10 | #84 [A6] · #98 [B10] · #121 [G4] cenários de integração | 1 | 0.5 | sprint M1 (2); mutação: sem SKIP LOCKED o A6 falha |
| 18/10 | #38 [S3.10] Dashboard: fila, DLQ, mapeamentos, caos e /metrics | 2.5 | 2.5 | controles desligados por padrão até a S5.3 |
| 18/10 | #46 [S5.3] Login no dashboard · #124 [H2] | 1.5 | 0.75 | HTTP Basic com comparação em tempo constante, sem dependência nova; sem senha o dashboard não sobe |
| 18/10 | #40 [S4.2] CI com E2E · A1, A2, B1, B2, B3, B6, C1, E4 | 4 | 2.5 | 9 cenários em ~3 min; B com volume próprio no E2E (tmpfs apagava o B no B1) |
| 18/10 | #41 [S4.3] VM Oracle + Caddy HTTPS (parte do repositório) | 2.5 | 0.75 | bootstrap idempotente, .env de produção e passo a passo; a VM em si depende da conta Oracle |
| 18/10 | #42 [S4.4] Deploy automático na Prod | 2 | 0.75 | GHCR multi-arch, aprovação no Environment, smoke HTTPS e rollback por tag |

## Totais por milestone

| Milestone | Estimado (h) | Real (h) |
|---|---|---|
| M0 · Fundação | 7.5 | |
| M1 · Núcleo A→B | | |
| M2 · Auditoria & Segurança | | |
| M3 · B→A (opcional) | | |
| M4 · Notas & Mocks (opcional) | | |
| M5 · Entrega | | |
| **Total** | | |
