# Fora do escopo

O que ficou de fora do desafio e por quê. Cada item diz o que foi feito no lugar e o caminho para produção.

- **Simulado**: existe no projeto, mas como mock. Marcado com *simulado: como seria em produção*.
- **Fora**: não existe. Marcado com *como eu faria*.

## Critério de corte

1. **16/10:** o avaliador confirmou que o obrigatório é o **A → B**; o **B → A** é opcional.
2. **18/10, revisão de escopo:** com o prazo de 22/10, a estratégia passou a ser **entregar o núcleo A → B à prova de caos, publicado e documentado**. Tudo o que não prova uma das três garantias virou desenho documentado. As três garantias (sem duplicata, sem atualização perdida, sem dado antigo sobre novo) nunca foram negociadas.
3. **19/10, realinhamento ao PDF:** o PDF é a régua (ADR-013). O A é o sistema central e soluciona e fecha chamados; o B só recebe. O que tinha sobrado do desenho B → A nas UIs saiu ou ganhou aviso.

O desenho de tudo o que saiu continua nos ADRs e no [plano](PLANO_DE_ACAO.md). As issues foram fechadas como *not planned* com a label `out-of-scope`.

## Simulados

| Item | O que existe aqui | Simulado: como seria em produção |
|---|---|---|
| **Sistema A (GLPI)** | Mock em Node que imita a API do GLPI: `initSession`, `Ticket`, status 1–6, `date_mod` no fuso do A, webhook com HMAC e perda simulada | GLPI real com `App-Token` e um usuário técnico `sync-bot` de permissões mínimas. O adaptador do A já fala a API do GLPI; mudaria a URL, as credenciais e a forma de ler o `date_mod` em massa (`searchOptions`) |
| **Sistema B** | Mock em .NET que implementa **só** o contrato mínimo (criar, ler, atualizar, listar e um texto devolvido como gravado), com caos reproduzível | O sistema do terceiro. O sync não muda: só o contrato mínimo é assumido (ADR-003). Antes de ligar, mediria o comportamento real de paginação e códigos HTTP |
| **Caos do B** | Middleware com latência, 5xx, timeout com gravação tardia, grava-e-falha, ack sem gravar, 200 com erro, 429, texto truncado e listagem instável, com seed | Em produção o caos é o próprio B. Para ensaio, injeção de falhas na borda (proxy tipo Toxiproxy) num ambiente de homologação, nunca no B real |
| **Login e perfis** | Sessão simples no A (Técnico, Estagiário, `sync-bot`) e login do dashboard por variável de ambiente | SSO (OIDC/SAML) no dashboard, perfis do GLPI reais, rotação de credenciais no cofre de segredos |
| **Hospedagem** | Uma VM Oracle Always Free com Docker Compose e Caddy, **um único ambiente (produção)**, com deploy a partir da `Prod`. A `Dev` só roda a CI (ADR-010) | Homologação e produção em contas/VMs separadas, Postgres gerenciado com backup e PITR, deploy com healthcheck e rollback automáticos |

## Fora: cortado na revisão de 18/10

| Item | Por que ficou de fora | Como eu faria |
|---|---|---|
| **Retorno B → A** (o B propõe, o A aprova: resolver, excluir, reabrir; congelamento a partir do status 5; exclusão em 2 passos) | Opcional segundo o avaliador; não prova nenhuma das três garantias do A → B | Desenho completo nos ADRs **006** (proposta + aprovação + congelamento × SLA) e **007** (exclusão em 2 passos). O sync varreria o B, compararia com o `last_written_hash` e transformaria a mudança em proposta no A (status 5 + Solução pendente); só o Técnico aprova |
| **Mudanças feitas direto no B** (o operador resolve, fecha, reabre, exclui ou edita) | Sem o B → A, nada disso volta ao A | Hoje a próxima alteração do chamado no A sobrescreve o B (o A vence), e a UI do B avisa. **Risco conhecido:** um chamado fechado no B é reaberto se o A for editado depois. Com o B → A: varrer o B, tratar a mudança como proposta (ADR-006) e ler antes de escrever (ADR-011) para não sobrescrever |
| **Anti-eco (ida e volta A ↔ B)** | Só existe problema de eco quando há os dois sentidos | ADR-**009**: `last_written_hash` por registro do B (o que eu mesmo escrevi não é mudança do B), escritas do `sync-bot` não disparam sync A → B e o hash do A ignora `date_mod`. Prova: estabilização em 3 ciclos sem escrita extra |
| **A e B alterando o mesmo chamado ao mesmo tempo** | Idem: só existe com os dois sentidos | ADR-**011**: o A vence; a mudança do B vira proposta obsoleta ou é revertida, sempre com nota; ler antes de escrever e `If-Match` quando o B oferecer ETag. O risco residual sem ETag fica documentado |
| **Notas e comentários nos dois sentidos** | Não fazem parte do A → B obrigatório | Marcador por nota (`⟦n:id⟧`) + `note_mapping`, com a mesma regra dos chamados: em caso de dúvida, procurar o marcador antes de reenviar, nunca reenviar às cegas |
| **Auditoria append-only e linha do tempo por chamado** | Os logs JSON com `correlation_id` bastam para a demo | Tabela `audit_log` sem permissão de UPDATE/DELETE para o usuário do sync, segredos mascarados, retenção de 30 dias e uma tela com a história de cada chamado |
| **Auditor anti-entropia** (varredura periódica do B) | A verificação pós-escrita cobre o caso principal (o B diz que gravou e não gravou) | Job periódico que relê os registros mapeados (ativos a cada 30 s, fechados a cada 10 min), compara o hash com o do A e enfileira correção, com concorrência limitada e desaceleração em 429 |
| **Teste de capacidade do marcador** | O mock do B preserva o texto; num B real seria a primeira coisa a validar | Na subida, gravar um registro de teste, reler e conferir se o marcador voltou intacto; se não voltar, entrar em modo seguro (creates ambíguos vão para quarentena com alerta, sem recriação automática) |
| **Homologação separada** (`dev.<host>`) | Dois ambientes dobram o trabalho de deploy sem mudar o que é avaliado | Segundo projeto compose (`cybercorp-dev`) com o seu Postgres e `.env`, deploy a cada merge na `Dev` e promoção da mesma imagem para a produção |
| **Alertas** | Fora do núcleo | Tabela de saída (padrão outbox) para DLQ crescendo e B fora do ar, com envio por e-mail/Slack, deduplicação por chamado e janela de silêncio |
| **Anexos** | Fora do núcleo | Sincronizar metadados (nome, tamanho, `sha256`) e o binário via storage intermediário com URL assinada, idempotente pelo `sha256` |
| **Usuários, grupos, categorias e localização** | Viram texto simples no B | De-para mantido no GLPI (campos customizados) ou num diretório (LDAP/AD), com cache e alerta quando um valor não tiver correspondência |
| **SLA (TTR/TTO)** | Fora do núcleo | SLA nativo do GLPI (calendários, feriados e pausas) |
| **Scans de segurança na CI** | Prazo | `npm audit --audit-level=high`, `dotnet list package --vulnerable` e secret scanning do GitHub como jobs da CI |
| **Cenários de teste fora do núcleo** (de 61 para 14) | Os 14 restantes provam as três garantias; os demais dependiam do que foi cortado ou eram variações | O catálogo completo continua na seção 12 do plano |

## Fora: limites do desafio

| Item | Por que ficou de fora | Como eu faria |
|---|---|---|
| **Mirror no GitLab** | O enunciado aceita GitHub **ou** GitLab, e o pull mirror do GitLab é recurso pago (ADR-012) | Um job no GitHub Actions que, a cada push na `Dev` e na `Prod`, faz `git push --mirror` para o GitLab com uma deploy key SSH com escrita guardada em GitHub Secrets |
| **Webhooks do B** | Contradiz o contrato mínimo: não podemos assumir que o B avisa nada | Se o B oferecesse, entraria como **acelerador**, igual ao webhook do A: o evento continua sendo só um sinal |
| **Alta disponibilidade e multi-região** | A infra gratuita é uma VM só | Várias réplicas do sync já funcionam pelo desenho (`SKIP LOCKED` + lease + um job ativo por chamado). Faltaria Postgres em HA (primário + réplica com failover) e réplicas atrás de um balanceador |
| **Grafana, Loki, Prometheus** | Custo de operação maior que o ganho no prazo | O sync já loga JSON com `correlation_id`. Bastaria apontar o Promtail/Loki para os logs e expor um `/metrics` para o Prometheus, com alertas para DLQ crescendo, breaker aberto e atraso do poll |
| **Carga massiva** (milhares de chamados por minuto) | Fora do catálogo de cenários de propósito | Particionar `sync_jobs` por faixa de `ticket_id`, aumentar workers e fazer testes de carga (k6) com o caos ligado |
| **Falha de disco e corrupção do banco** | Exige infraestrutura que a VM gratuita não tem | Backups automáticos com restauração testada, WAL archiving e PITR. Depois de restaurar, voltar o checkpoint do poller para antes do backup: como o worker é idempotente (marcador + hash), reprocessar não duplica |
| **Partição de rede por dias** | O sync tolera o B fora por até 24 h por job; depois vai para a DLQ | Aumentar a janela de retry por configuração e, na volta, reprocessar a DLQ: o reprocessamento sempre relê o A, então o que chega ao B é o estado atual, não um payload velho |
| **Proteção contra DoS** | Fora do escopo do desafio | Rate limit por IP no Caddy, WAF/CDN na frente, limite de tamanho de corpo e fila de entrada com contrapressão |
| **Sincronização de chamados antigos (backfill)** | O poller começa do checkpoint da primeira subida | Um comando de backfill que enfileira chamados por faixa de `date_mod`, com o mesmo worker idempotente: rodar duas vezes não duplica |
