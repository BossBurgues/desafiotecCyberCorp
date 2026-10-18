# Fora do escopo

O que ficou de fora do desafio e por quê. Cada item diz o que foi feito no lugar e o caminho para produção.

- **Simulado**: existe no projeto, mas como mock. Marcado com *simulado: como seria em produção*.
- **Fora**: não existe. Marcado com *como eu faria*.

O critério de corte veio do avaliador (16/10): o obrigatório é o **A → B**; o **B → A** é opcional. Por isso os milestones M3 (propostas e aprovação) e M4 (notas, localização e mocks) são os primeiros a sair se faltar tempo, e as três garantias do núcleo nunca são negociadas.

## Simulados

| Item | O que existe aqui | Simulado: como seria em produção |
|---|---|---|
| **Sistema A (GLPI)** | Mock em Node que imita a API do GLPI: `initSession`, `Ticket`, `ITILFollowup`, `ITILSolution`, status 1–6, `date_mod` no fuso do A | GLPI real com `App-Token` e um usuário técnico `sync-bot` de permissões mínimas. O adaptador do A já fala a API do GLPI; mudaria a URL, as credenciais e a forma de ler o `date_mod` em massa (`searchOptions`) |
| **Sistema B** | Mock em .NET que implementa **só** o contrato mínimo (criar, ler, atualizar, listar e um texto devolvido como gravado), com caos reproduzível | O sistema do terceiro. O sync não muda: só o contrato mínimo é assumido (ADR-003). Antes de ligar, rodaria o teste de capacidade do marcador e mediria o comportamento real de paginação e códigos HTTP |
| **Caos do B** | Middleware com latência, 5xx, timeout com gravação tardia, grava-e-falha, ack sem gravar, 200 com erro, 429, texto truncado e listagem instável, com seed | Em produção o caos é o próprio B. Para ensaio, injeção de falhas na borda (proxy tipo Toxiproxy) num ambiente de homologação, nunca no B real |
| **Alertas** | `alerts_outbox`: caixa de saída de e-mail visível no dashboard (DLQ, quarentena, exclusão pedida) | Envio por e-mail/Slack/PagerDuty a partir da mesma tabela (padrão outbox), com deduplicação por chamado e janela de silêncio |
| **Anexos** | Só metadados: nome, tamanho e `sha256` | Download do anexo no A, upload para um storage do B (ou um bucket intermediário com URL assinada), idempotente pelo `sha256` |
| **Usuários, grupos e categorias** | Tabela de-para estática no sync | De-para mantido no próprio GLPI (campos customizados) ou num serviço de diretório (LDAP/AD), com cache e alerta quando um valor não tiver correspondência |
| **SLA (TTR/TTO)** | Calculado no mock do A a partir da `solvedate` | SLA nativo do GLPI (calendários, feriados e pausas). O congelamento a partir do status 5 já existe para não mexer no SLA |
| **Login e perfis** | Sessão simples no A (Técnico, Estagiário, `sync-bot`) e login do dashboard por variável de ambiente | SSO (OIDC/SAML) no dashboard, perfis do GLPI reais, rotação de credenciais no cofre de segredos |
| **Hospedagem** | Uma VM Oracle Always Free, Docker Compose e Caddy, homologação e produção na mesma máquina (ADR-010) | Ambientes em contas/VMs separadas, Postgres gerenciado com backup e PITR, deploy com healthcheck e rollback automáticos |

## Fora

| Item | Por que ficou de fora | Como eu faria |
|---|---|---|
| **Mirror no GitLab** | O enunciado aceita GitHub **ou** GitLab, e o pull mirror do GitLab é recurso pago (ADR-012) | Um job no GitHub Actions que, a cada push na `Dev` e na `Prod`, faz `git push --mirror` para o GitLab com uma deploy key SSH com escrita guardada em GitHub Secrets |
| **Webhooks do B** | Contradiz o contrato mínimo: não podemos assumir que o B avisa nada | Se o B oferecesse, entraria como **acelerador**, igual ao webhook do A: o auditor continua sendo a garantia e o evento continua sendo só um sinal |
| **Alta disponibilidade e multi-região** | A infra gratuita é uma VM só | Várias réplicas do sync já funcionam pelo desenho (`SKIP LOCKED` + lease + um job ativo por chamado). Faltaria Postgres em HA (primário + réplica com failover) e réplicas atrás de um balanceador |
| **Grafana, Loki, Prometheus** | Custo de operação maior que o ganho no prazo | O sync já loga JSON com `correlation_id`, e o `/metrics` está previsto no desenho (seção 3 do plano). Bastaria apontar o Promtail/Loki para os logs e o Prometheus para o `/metrics`, com alertas para DLQ crescendo, breaker aberto e atraso do poll |
| **Edição de campos pelo B com aprovação campo a campo** | Só o ciclo de vida (resolver, excluir, reabrir) passa por aprovação. Edição de campo no B é **revertida + nota** | Uma proposta por campo, com `based_on_hash` por campo, tela de revisão no A e regras de quais campos o B pode propor |
| **Carga massiva** (milhares de chamados por minuto) | Fora do catálogo de cenários de propósito | Particionar `sync_jobs` por faixa de `ticket_id`, aumentar workers, varredura do B incremental por `updatedAt` se o B oferecer, e testes de carga (k6) com o caos ligado |
| **Falha de disco e corrupção do banco** | Exige infraestrutura que a VM gratuita não tem | Backups automáticos com restauração testada, WAL archiving e PITR. Depois de restaurar, o auditor anti-entropia reconcilia A e B sozinho |
| **Partição de rede por dias** | O sync tolera o B fora por até 24 h por job (depois vai para a DLQ com alerta, cenário E7) | Aumentar a janela de retry por configuração e, na volta, reprocessar a DLQ: o reprocessamento sempre relê o A, então o que chega ao B é o estado atual, não um payload velho |
| **Proteção contra DoS** | Fora do escopo do desafio | Rate limit por IP no Caddy, WAF/CDN na frente, limite de tamanho de corpo e fila de entrada com contrapressão |
| **Exclusão física no A** | O A nunca exclui: fecha (status 6) para preservar histórico e auditoria (ADR-007) | Se a política exigir (LGPD), anonimização dos dados pessoais mantendo o esqueleto do chamado e a trilha de auditoria |
| **Sincronização de chamados antigos (backfill)** | O poller começa do checkpoint da primeira subida | Um comando de backfill que enfileira chamados por faixa de `date_mod`, com o mesmo worker idempotente: rodar duas vezes não duplica |
