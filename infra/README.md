# Infra

- `docker-compose.yml`: ambiente completo (local = CI = VM): A, B, sync, Postgres 16 e Caddy
- `docker-compose.e2e.yml`: override dos testes E2E (caos agressivo, estado descartável)
- `docker-compose.e2e.nowebhook.yml`: o A sem webhook, usado pelo cenário B2
- `.env.production.example`: variáveis de produção (os valores só existem na VM)
- `caddy/Caddyfile`: reverse proxy com HTTPS automático, um host por sistema
- `scripts/`: smoke dos containers e `bootstrap-vm.sh` (prepara a VM do zero)

Hospedagem: VM Oracle Always Free (plano B: Render + Neon, ADR-010). Issues: épico **E4**.

## Subir tudo (S4.1)

```bash
cp .env.example .env                                                     # valores de desenvolvimento
docker compose -f infra/docker-compose.yml --env-file .env up -d --build --wait
docker compose -f infra/docker-compose.yml --env-file .env down          # -v apaga os volumes
```

| Serviço | Pela rede local | Pelo Caddy (`DOMAIN=localhost`) | Healthcheck |
|---|---|---|---|
| `system-a` | `127.0.0.1:3001` | `https://a.localhost` | `GET /health` (node) |
| `system-b` | `127.0.0.1:5002` | `https://b.localhost` (sem `/admin`) | binário com `--healthcheck` |
| `sync-service` | `127.0.0.1:3000` | `https://sync.localhost` | `GET /health` (node) |
| `postgres` | só na rede do compose | — | `pg_isready` |
| `caddy` | `:80` / `:443` | — | API de admin local `:2019` |

- **Segredos sem padrão:** `POSTGRES_PASSWORD`, `A_APP_TOKEN`, `A_UI_APP_TOKEN`, `A_TECNICO_PASSWORD`, `A_ESTAGIARIO_PASSWORD`, `A_SYNC_BOT_TOKEN`, `HMAC_SECRET` e `B_ADMIN_TOKEN` usam `${VAR:?}`: sem eles o compose nem sobe. Nunca cai num valor de desenvolvimento em produção.
- **Volumes nomeados:** `postgres-data`, `system-a-data`, `system-b-data`, `caddy-data` (certificados) e `caddy-config`. Os dados sobrevivem a `down`/`up`; só `down -v` apaga.
- **Ordem de subida:** o sync espera só o Postgres ficar saudável. A ou B fora não impedem a subida: o `/ready` mostra e o worker pausa. O Caddy espera os três apps.
- **Portas dos apps em `127.0.0.1`:** acessíveis na máquina (testes, depuração), nunca expostas na rede. Na VM, só o Caddy publica portas.
- **Admin do B fora da internet:** o Caddy responde 404 para `/admin` em `b.<DOMAIN>`. Caos e wipe só pela rede interna (o dashboard do sync, S3.10) ou por `127.0.0.1:5002`.
- **Imagens:** `IMAGE_PREFIX` e `IMAGE_TAG` (padrão `cybercorp/*:local`). Na VM apontam para o GHCR (`ghcr.io/bossburgues/desafioteccybercorp/<app>:sha-<7>`), e o deploy faz `pull` em vez de `build`.
- O webhook do A vem ligado (`A_WEBHOOK_ENABLED=true`, receptor do sync na S3.4). Ele é só o sinal rápido: o poller do sync é a garantia quando um webhook se perde (Q1).

## E2E (caos agressivo)

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.e2e.yml --env-file .env.example up -d --build --wait
npm run e2e
docker compose -f infra/docker-compose.yml -f infra/docker-compose.e2e.yml --env-file .env.example down -v
```

O override **fixa** os valores (sem interpolação, para o `.env` de desenvolvimento não desligar o caos):

| O quê | Valor | Cenários |
|---|---|---|
| Seed do caos | 42 (reprodutível) | todos |
| 5xx / timeout (8 s, acima dos 5 s do sync) / grava e falha / ack sem gravar / 200 com erro / 429 | 10% / 5% / 5% / 3% / 5% / 5% | A1, A2, A3, B1, B5, E3, E4 |
| Paginação instável / atraso de listagem | 5% + 5% / 3 s | A7, E6 |
| Webhooks perdidos no A | 30% | B2 |
| Sync | `LOG_LEVEL=debug`, worker a cada 200 ms, disjuntor reabre em 5 s | — |
| Estado | Postgres em `tmpfs`; A e B em volumes próprios do projeto `cybercorp-e2e` (o B1 religa o B e o B2 recria o A sem perder dados). `down -v` apaga tudo | B1, B2 |
| Login do dashboard | `e2e` / senha fixa do override (ambiente descartável) | todos |
| Caddy | fora (perfil `caddy`); os testes usam as portas locais | — |

Combinações específicas de um cenário (drift de formato, texto truncado) são ligadas em tempo de execução pelo `PUT /admin/chaos`.

Na CI, o job `e2e` sobe esse ambiente e roda os cenários de `tests/e2e` em todo PR (ver `tests/e2e/README.md`).

## Produção: VM Oracle Always Free (S4.3)

Um único ambiente (revisão de 18/10): a branch `Prod` publica em `a.`, `b.` e `sync.<DOMAIN>` com HTTPS do Let's Encrypt.

### Passo a passo (uma vez, feito por você no console da Oracle)

1. **Conta Oracle Cloud Free Tier.** A região de casa não muda depois e a capacidade ARM varia (Ashburn e Phoenix costumam ter; São Paulo e Vinhedo costumam faltar).
2. **Chaves SSH:** uma sua para administrar e uma só para o GitHub Actions:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/cybercorp-vm -C cybercorp-vm
   ssh-keygen -t ed25519 -f ~/.ssh/cybercorp-deploy -N "" -C github-actions
   ```
3. **Compute → Instances → Create:** Ubuntu 24.04, shape `VM.Standard.A1.Flex` com 2 OCPU e 12 GB, IP público, chave `~/.ssh/cybercorp-vm.pub`. Sem capacidade: outro *availability domain*; depois `VM.Standard.E2.1.Micro` (o bootstrap liga 2 GB de swap); depois o plano B.
4. **Networking → VCN → Security List:** *ingress* TCP 80 e 443 de `0.0.0.0/0` (a 22 já existe; restrinja ao seu IP se puder).
5. **Domínio:** `DOMAIN=<ip-com-hifens>.sslip.io` (ex.: IP `203.0.113.10` → `203-0-113-10.sslip.io`). `a.`, `b.` e `sync.` resolvem sozinhos. Se o Let's Encrypt limitar o sslip.io, use um subdomínio do DuckDNS.
6. **Bootstrap** (Docker, usuário `deploy` com a chave do Actions, iptables 80/443, swap, `/opt/cybercorp`):
   ```bash
   scp -i ~/.ssh/cybercorp-vm infra/scripts/bootstrap-vm.sh ubuntu@<IP>:/tmp/
   ssh -i ~/.ssh/cybercorp-vm ubuntu@<IP> "sudo bash /tmp/bootstrap-vm.sh '$(cat ~/.ssh/cybercorp-deploy.pub)'"
   ```
7. **Segredos na VM:** copie `infra/.env.production.example` para `/opt/cybercorp/.env` e gere cada segredo com `openssl rand -hex 32`.
8. **Segredos no GitHub** (Settings → Environments → `production`): `SSH_HOST` (IP), `SSH_USER` (`deploy`), `SSH_KEY` (conteúdo de `~/.ssh/cybercorp-deploy`), `SSH_KNOWN_HOSTS` (saída de `ssh-keyscan <IP>`) e `DOMAIN`.

O firewall é o erro número 1 na Oracle: a imagem Ubuntu bloqueia tudo menos a 22 no iptables, além do Security List. Com a porta 80 fechada o Caddy não consegue o certificado (`docker compose logs caddy`).

### Deploy (S4.4)

`.github/workflows/deploy-prod.yml`, disparado pelo merge do PR de release `Dev` → `Prod`:

1. **images:** build multi-arquitetura (`linux/arm64` para a VM, `linux/amd64` para local e plano B) dos três apps, publicado no GHCR como `ghcr.io/bossburgues/desafioteccybercorp/<app>:sha-<7>` e `:prod`, com cache do Actions.
2. **deploy** (pausa para a **aprovação manual** do Environment `production`): copia `docker-compose.yml` e `Caddyfile` para `/opt/cybercorp/infra`, troca o `IMAGE_TAG` no `.env`, `docker compose pull` e `up -d --no-build --wait`. Postgres e volumes não são recriados; jobs em andamento têm lease e voltam sozinhos (B3). As migrations rodam na subida do sync.
3. **smoke:** `https://a.<DOMAIN>/health`, `https://b.<DOMAIN>/health` e `https://sync.<DOMAIN>/ready` com retry; `/dashboard` sem login tem de responder 401.

Depois do primeiro push, deixe os três pacotes do GHCR **públicos** (Package settings → Change visibility) para a VM puxar sem login; as imagens não têm segredo.

**Rollback:** Actions → `deploy-prod` → *Run workflow* com `tag: sha-xxxxxxx` de uma release anterior. Pula o build e só troca a versão na VM.

**Primeira subida sem o workflow** (para validar a VM), com as imagens já publicadas:

```bash
cd /opt/cybercorp && docker compose -f infra/docker-compose.yml --env-file .env up -d --no-build --wait
```

### Plano B (ADR-010)

Se a VM não sair até o fim de 20/10: **Render + Neon**. Um *Web Service* por app no Render apontando para as imagens `linux/amd64` do GHCR (mesmas variáveis do `.env.production.example`, `DATABASE_URL` do Neon no sync) e o Postgres no Neon. Se nem isso: Cloudflare Tunnel apontando para o compose local no dia da apresentação.
