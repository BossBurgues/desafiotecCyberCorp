# Runbook

Curto e orientado a ação: o que olhar e o que fazer quando algo foge do normal. Os comandos assumem a VM de produção (`/opt/cybercorp`, ver [`infra/README.md`](../infra/README.md)); localmente, troque `--env-file .env` por `--env-file .env.example` e rode da raiz do repositório.

```bash
cd /opt/cybercorp
alias dc='docker compose -f infra/docker-compose.yml --env-file .env'
```

## Onde olhar primeiro

| Sinal | Onde |
|---|---|
| Fila, DLQ, mapeamentos, disjuntor, alertas | `https://sync.<DOMAIN>/dashboard` (pede login) |
| Dependências de pé | `https://sync.<DOMAIN>/ready` (Postgres, A e B) |
| Métricas | `https://sync.<DOMAIN>/metrics` (login): `sync_jobs{status}`, `sync_dlq_pending`, `sync_ticket_mappings{state}`, disjuntor |
| Logs com `correlation_id` | `dc logs -f --since 10m sync-service` |

## Situações

| Situação | O que olhar | O que fazer |
|---|---|---|
| **DLQ crescendo** | Dashboard → DLQ: `error_class` e `last_error`; `sync_dlq_pending` | **Permanente** (`MappingError`, 422 do B, obrigatório vazio): corrigir o chamado no A e clicar em **reprocessar** (cria um job novo que relê o A, B10). **Transitório** que passou de 24 h: conferir o B e reprocessar |
| **B fora do ar** | Disjuntor `open` no dashboard; `/ready` com `system_b` falhando | Nada. Os jobs esperam sem gastar tentativas e a fila drena quando o B volta (B1, E4). Se passar de 24 h, reprocessar a DLQ |
| **Chamado parado em `create_uncertain`** | Dashboard → Mapeamentos | Normal por até `CREATE_UNCERTAIN_SCANS` (2) varreduras: o sync procura `⟦s:glpi-<id>⟧` na listagem do B e adota, ou recria se não achar. Se persistir, conferir no B (`/operator/records`) se o registro existe e se o marcador está intacto |
| **Verificação pós-escrita falhando sempre** | Logs `verify` com `outcome=mismatch` | O B está alterando o conteúdo gravado (ex.: caos `TruncateText`). Desligar o caos ou corrigir o B; o job tenta de novo com backoff e vai para a DLQ em 24 h |
| **Registro sumiu do B** | Logs `record_missing` | Automático: o sync procura o marcador e adota, ou recria depois de N varreduras. O ID antigo fica em `ticket_mapping.b_record_history` |
| **Chamados não chegam** | `/ready`; `dc logs system-a` (webhook) | O poller cobre webhook perdido (B2) a cada `POLL_INTERVAL_MS`. Se nem o poller trouxer: conferir `A_SYNC_BOT_TOKEN` e o login do sync-bot no log |
| **Sync não sobe** | `dc logs sync-service` | A mensagem do zod lista a variável faltando ou inválida no `.env` (sem mostrar valores) |
| **Dashboard responde 404** | `dc logs sync-service \| grep DASHBOARD` | Falta `DASHBOARD_USER`/`DASHBOARD_PASSWORD` (senha com 12+ caracteres). Falha segura: sem login o dashboard não sobe |
| **Certificado HTTPS não sai** | `dc logs caddy` | Porta 80 fechada no iptables da VM ou no Security List da Oracle. Limite do Let's Encrypt no sslip.io → trocar para DuckDNS |
| **Deploy com problema** | Run do `deploy-prod` no Actions | **Rollback:** *Run workflow* com a tag `sha-…` anterior (sem rebuild) |
| **Deploy durante a sincronização** | — | Seguro: Postgres e volumes não são recriados, só os apps trocam. Jobs `running` voltam pelo lease (B3) |
| **B reiniciado vazio** (restauração, wipe) | Jobs com `duplicate key … ticket_mapping_b_record_id_key` | Fora do escopo: o B reusa IDs que já estão mapeados. Limpar os mapeamentos (`DELETE FROM ticket_mapping`) faz o sync recriar tudo pelo marcador |

## Demo de caos

1. Dashboard → **Caos do Sistema B** → ligar, por exemplo, `ErrorRate 0.5` ou `LatencyMs 10000`.
2. Criar e editar chamados no A (`https://a.<DOMAIN>/ui/`) e mostrar a fila crescer, o disjuntor abrir e a DLQ vazia.
3. **Reset do caos** → a fila drena; conferir no B (`https://b.<DOMAIN>/`) cada chamado uma vez, atualizado.
4. Sempre terminar com o reset: em produção o caos começa desligado.

## Comandos úteis

```bash
dc ps                                   # estado e saúde dos containers
dc logs -f --since 10m sync-service     # logs JSON do sync
dc restart sync-service                 # seguro: jobs em andamento voltam pelo lease
dc exec postgres psql -U sync -d sync -c "SELECT status, count(*) FROM sync_jobs GROUP BY 1"
dc exec postgres psql -U sync -d sync -c "SELECT ticket_id, attempts, error_class, last_error FROM sync_jobs WHERE status = 'dead' AND reprocessed_at IS NULL"
dc exec postgres psql -U sync -d sync -c "SELECT state, count(*) FROM ticket_mapping GROUP BY 1"
```
