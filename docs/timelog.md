# Registro de horas

Desafio recebido em **16/10/2026**. Entrega-alvo: **22/10/2026**.

**Critério (decisão de 19/10):** as horas saem dos **registros do GitHub** (commits, merges, PRs e issues), não de estimativa. O dia é a soma das sessões de trabalho, descontando pausas acima de 1 h. A linha de cada issue vai do primeiro ao último commit com `Refs #n` naquele dia, mais 15 min. Como várias issues andaram juntas (commits intercalados), a soma das linhas passa do relógio: **o total que vale é o do dia**. 16/10 não tem registro no GitHub até a primeira issue (19:43); os valores são os informados.

## Por dia

| Dia | Registro no GitHub | Sessões | Horas |
|---|---|---|---|
| 16/10 | issues, milestones e Project criados (primeira issue às 19:43); sem commits | plano 2,5 h · backlog 1 h · resposta do avaliador 2 h (informado) | 5,5 |
| 17/10 | nada | — | 0 |
| 18/10 | 321 eventos (commits, merges, PRs, issues) | 08:41–13:14 · 14:23–17:37 · 19:28–21:43 | 10 |
| 19/10 | 122 eventos (commits, merges, PRs, issues); registro até 18:47 | 07:29–07:44 · 10:07–12:10 · 13:13–16:43 · 18:35–18:42 | 6 |
| **Total** | | | **21,5** |

## Por issue (do primeiro ao último commit no dia, + 15 min)

| Dia | Issue | Milestone | Commits | Horas |
|---|---|---|---|---|
| 18/10 | #135 #135 | — | 1 | 0,25 |
| 18/10 | #12 [S0.1] Estrutura do monorepo, README inicial, CONTRIBUTING e timelog | M0 · Fundação | 1 | 0,25 |
| 18/10 | #13 [S0.2] CI esqueleto com detecção de mudanças por app | M0 · Fundação | 4 | 0,25 |
| 18/10 | #14 [S0.3] ADRs 001–010 | M0 · Fundação | 14 | 0,25 |
| 18/10 | #15 [S0.4] Contratos OpenAPI do A e do B + schema do evento | M0 · Fundação | 10 | 0,5 |
| 18/10 | #16 [S1.1] API de chamados estilo GLPI | M1 · Núcleo A→B (3 garantias) | 14 | 0,5 |
| 18/10 | #17 [S1.2] Usuários e perfis: Técnico, Estagiário, sync-bot | M1 · Núcleo A→B (3 garantias) | 13 | 0,5 |
| 18/10 | #22 [S1.7] Testes e Dockerfile do Sistema A | M1 · Núcleo A→B (3 garantias) | 10 | 0,25 |
| 18/10 | #18 [S1.3] Webhook ticket.changed com HMAC e modo "perder X%" | M1 · Núcleo A→B (3 garantias) | 11 | 0,5 |
| 18/10 | #23 [S2.1] API de records do B (contrato mínimo, formato próprio) | M1 · Núcleo A→B (3 garantias) | 8 | 0,25 |
| 18/10 | #21 [S1.6] UI do Sistema A (login, lista, chamado, conversa, aprovações) | M1 · Núcleo A→B (3 garantias) | 13 | 0,5 |
| 18/10 | #30 [S3.2] Domínio puro: mapper A→B, hash, fuso | M1 · Núcleo A→B (3 garantias) | 12 | 0,5 |
| 18/10 | #28 [S2.6] Testes xUnit e Dockerfile do Sistema B | M1 · Núcleo A→B (3 garantias) | 5 | 0,5 |
| 18/10 | #24 [S2.2] Middleware de caos configurável e reproduzível | M1 · Núcleo A→B (3 garantias) | 4 | 0,25 |
| 18/10 | #26 [S2.4] UI do Operador B | M1 · Núcleo A→B (3 garantias) | 4 | 0,25 |
| 18/10 | #29 [S3.1] Bootstrap do sync: config, logs, HTTP, health/ready, migrations | M1 · Núcleo A→B (3 garantias) | 6 | 0,25 |
| 18/10 | #64 [S9.2] architecture.md com diagramas Mermaid | M5 · Entrega | 2 | 0,25 |
| 18/10 | #67 [S9.5] out-of-scope.md | M5 · Entrega | 1 | 0,25 |
| 18/10 | #27 [S2.5] Admin do B: apagar registro, wipe, drift de formato | M1 · Núcleo A→B (3 garantias) | 3 | 2,25 |
| 18/10 | #33 [S3.5] Adapter B: timeout, circuit breaker, validação de resposta | M1 · Núcleo A→B (3 garantias) | 2 | 0,25 |
| 18/10 | #43 [S4.5] Mirror no GitLab | M5 · Entrega | 2 | 0,25 |
| 18/10 | #31 [S3.3] Fila: um job por chamado, SKIP LOCKED, lease, backoff, DLQ | M1 · Núcleo A→B (3 garantias) | 4 | 2,25 |
| 18/10 | #39 [S4.1] Docker Compose completo (local = produção) + override E2E | M1 · Núcleo A→B (3 garantias) | 3 | 0,25 |
| 18/10 | #34 [S3.6] processJob: create/update idempotente com marcador | M1 · Núcleo A→B (3 garantias) | 6 | 0,5 |
| 18/10 | #32 [S3.4] Entrada: webhook HMAC + poller com sobreposição | M1 · Núcleo A→B (3 garantias) | 4 | 0,25 |
| 18/10 | #98 [B10] reprocessar da DLQ relê o A | M1 · Núcleo A→B (3 garantias) | 1 | 0,25 |
| 18/10 | #121 [G4] obrigatório vazio → 422 | M1 · Núcleo A→B (3 garantias) | 1 | 0,25 |
| 18/10 | #84 [A6] dois workers no mesmo chamado | M1 · Núcleo A→B (3 garantias) | 1 | 0,25 |
| 18/10 | #38 [S3.10] Dashboard básico: fila, DLQ, mapeamentos, controles de caos | M1 · Núcleo A→B (3 garantias) | 2 | 1,25 |
| 18/10 | #91 [B3] sync cai no meio do job | M1 · Núcleo A→B (3 garantias) | 2 | 1,5 |
| 18/10 | #36 [S3.8] Verificação pós-escrita e tratamento de 404 | M1 · Núcleo A→B (3 garantias) | 5 | 0,75 |
| 18/10 | #93 [B5] ack sem gravar | M1 · Núcleo A→B (3 garantias) | 1 | 0,25 |
| 18/10 | #46 [S5.3] Login no dashboard e proteção dos controles de caos | M1 · Núcleo A→B (3 garantias) | 5 | 0,25 |
| 18/10 | #124 [H2] dashboard sem login | M1 · Núcleo A→B (3 garantias) | 1 | 0,25 |
| 18/10 | #40 [S4.2] Pipeline CI completo (lint, testes, integração, E2E) | M1 · Núcleo A→B (3 garantias) | 10 | 0,5 |
| 18/10 | #79 [A1] commit-then-fail não duplica | M1 · Núcleo A→B (3 garantias) | 1 | 0,25 |
| 18/10 | #80 [A2] timeout com gravação tardia não duplica | M1 · Núcleo A→B (3 garantias) | 1 | 0,25 |
| 18/10 | #94 [B6] 20 updates em 1 s | M1 · Núcleo A→B (3 garantias) | 1 | 0,25 |
| 18/10 | #101 [C1] eventos fora de ordem | M1 · Núcleo A→B (3 garantias) | 1 | 0,25 |
| 18/10 | #90 [B2] webhook perdido | M1 · Núcleo A→B (3 garantias) | 1 | 0,25 |
| 18/10 | #164 [E4] B lento (10 s por requisição) | M1 · Núcleo A→B (3 garantias) | 1 | 0,25 |
| 18/10 | #89 [B1] B fora por 1 h | M1 · Núcleo A→B (3 garantias) | 1 | 0,25 |
| 18/10 | #41 [S4.3] VM Oracle Always Free + Caddy HTTPS | M1 · Núcleo A→B (3 garantias) | 4 | 0,25 |
| 18/10 | #42 [S4.4] Deploy automático na Prod (GHCR + SSH + smoke + rollback) | M1 · Núcleo A→B (3 garantias) | 3 | 0,25 |
| 18/10 | #66 [S9.4] field-mapping.md e runbook.md | M5 · Entrega | 1 | 0,25 |
| 19/10 | #41 [S4.3] VM Oracle Always Free + Caddy HTTPS | M1 · Núcleo A→B (3 garantias) | 1 | 0,25 |
| 19/10 | #65 [S9.3] how-it-works.md: passeio guiado pelo código | M5 · Entrega | 2 | 0,25 |
| 19/10 | #63 [S9.1] README completo | M5 · Entrega | 4 | 1,25 |
| 19/10 | #174 [S9.9] Realinhamento ao PDF: o A é o central, o B só recebe | M5 · Entrega | 22 | 4,25 |
| 19/10 | #118 [G1] todos os valores de status/prioridade | M1 · Núcleo A→B (3 garantias) | 1 | 0,25 |
| 19/10 | #130 [C7] A e B alteram o mesmo campo ao mesmo tempo | M3 · B→A Propostas & Aprovação (opcional) | 1 | 0,25 |
| 19/10 | #69 [S9.7] Roteiro da demo e vídeo de backup | M5 · Entrega | 1 | 0,25 |

## Por milestone (soma das linhas por issue; passa do relógio pelas sobreposições)

| Milestone | Horas (linhas) |
|---|---|
| M0 · Fundação | 1,25 |
| M1 · Núcleo A→B (3 garantias) | 18,25 |
| M3 · B→A Propostas & Aprovação (opcional) | 0,25 |
| M5 · Entrega | 7 |
| sem milestone | 0,25 |

Gerado a partir do `git log` e da API do GitHub em 19/10/2026 18:47 (horário de Brasília).
