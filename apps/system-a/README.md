# Sistema A: mock do GLPI (Node.js + JavaScript)

A **fonte da verdade** dos chamados (ADR-001, ADR-005). Imita a API REST do GLPI 10 nos pontos que importam para a sincronização:

- status `1`–`6` (Novo, Em atendimento, Planejado, Pendente, Solucionado, Fechado) e prioridade `1`–`6`;
- categoria (`itilcategories_id`), localização (`locations_id`), requerente (`users_id_recipient`) e atribuído (`users_id_assign`) como IDs numéricos;
- `date` e `date_mod` **sem fuso horário** (`YYYY-MM-DD HH:MM:SS`), formatados no fuso do servidor (`A_TIMEZONE`); não há campo de versão nem `ETag`;
- autenticação por `App-Token` + `Session-Token` (`/initSession`, `/killSession`) com três perfis (`tecnico`, `estagiario`, `sync-bot`) e registro append-only de negações `401`/`403`;
- persistência em SQLite (`better-sqlite3`), com ordenação estável por `(date_mod, id)`.

Contrato: [`contracts/system-a.openapi.yaml`](../../contracts/system-a.openapi.yaml). Issues: épico **E1**.

## Como rodar e testar

Na raiz do monorepo:

```bash
npm ci
npm run test -w apps/system-a
cp .env.example .env
npm run start -w apps/system-a
```

### Variáveis de ambiente

| Variável | Padrão (fora de `production`) | Descrição |
|---|---|---|
| `PORT` | `3001` | Porta HTTP do servidor Fastify (prefixo `/apirest.php`) |
| `A_TIMEZONE` | `America/Sao_Paulo` | Fuso usado para formatar `date` e `date_mod` sem offset (ADR-005) |
| `A_DB_PATH` | `./data/system-a.db` | Caminho do arquivo SQLite (`:memory:` em testes) |
| `A_APP_TOKEN` | `dev-app-token` | Token de aplicação exigido no cabeçalho `App-Token` em todas as rotas |
| `A_TECNICO_PASSWORD` | `dev-tecnico-password` | Senha do usuário `tecnico` (ID `1`, login via `Authorization: Basic`) |
| `A_ESTAGIARIO_PASSWORD` | `dev-estagiario-password` | Senha do usuário `estagiario` (ID `2`, login via `Authorization: Basic`) |
| `A_SYNC_BOT_TOKEN` | `dev-sync-bot-token` | Token da conta de serviço `sync-bot` (ID `3`, login via `Authorization: user_token`) |
| `A_TRUST_PROXY` | `false` | Quando `true`, habilita `trustProxy` no Fastify para registrar o IP real atrás do Caddy (`X-Forwarded-For`) |
| `A_WEBHOOK_ENABLED` | `false` | Quando `true`, envia o webhook HTTP `ticket.changed` (exige `A_WEBHOOK_URL` e `HMAC_SECRET`) |
| `A_WEBHOOK_URL` | — | URL HTTP/HTTPS completa do receptor do webhook (sugestão em dev: `http://localhost:3000/webhooks/system-a`) |
| `A_WEBHOOK_DROP_RATE` | `0` | Porcentagem (`0`–`100`) de eventos descartados propositalmente antes do envio para exercitar o cenário B2 |
| `HMAC_SECRET` | — | Segredo compartilhado com o sincronizador para assinar `X-Signature-256` (em `NODE_ENV=production` exige `>= 32` caracteres quando o webhook está ligado) |
| `NODE_ENV` | — | Quando `production`, a ausência de `A_APP_TOKEN`, `A_TECNICO_PASSWORD`, `A_ESTAGIARIO_PASSWORD` ou `A_SYNC_BOT_TOKEN` (e `HMAC_SECRET` curto com webhook ligado) impede o servidor de subir |

## Login e perfis (S1.2 · #17)

Todas as rotas sob `/apirest.php` exigem o cabeçalho `App-Token`. Exceto `/initSession`, todas também exigem `Session-Token`.

### Exemplo de abertura e encerramento de sessão (`curl`)

```bash
# 1. Login humano (Técnico ou Estagiário) via Basic
BASIC=$(printf 'tecnico:dev-tecnico-password' | base64)
curl -s http://localhost:3001/apirest.php/initSession \
  -H "App-Token: dev-app-token" \
  -H "Authorization: Basic $BASIC"
# -> {"session_token":"<hex de 64 chars>"}

# 2. Login da conta de serviço (sync-bot) via user_token
curl -s http://localhost:3001/apirest.php/initSession \
  -H "App-Token: dev-app-token" \
  -H "Authorization: user_token dev-sync-bot-token"

# 3. Encerrar sessão
curl -i http://localhost:3001/apirest.php/killSession \
  -H "App-Token: dev-app-token" \
  -H "Session-Token: <session_token>"
```

### Matriz de permissões (`auth.js`)

| Ação | Técnico (`id=1`) | Estagiário (`id=2`) | `sync-bot` (`id=3`) | Rotas |
|---|---|---|---|---|
| `ticket.read` | ✅ | ✅ | ✅ | `GET /Ticket`, `GET /Ticket/:id` |
| `ticket.create` | ✅ | ✅ | ❌ (`403`) | `POST /Ticket` |
| `ticket.update` | ✅ | ❌ (`403`) | ❌ (`403`) | `PUT /Ticket/:id` |
| `followup.create` | ✅ | ❌ (`403`) | ✅ | `POST /ITILFollowup` (S1.4) |
| `solution.create` | ✅ | ❌ (`403`) | ✅ | `POST /ITILSolution` (S1.5 / M3) |
| `solution.decide` | ✅ | ❌ (`403`) | ❌ (`403`) | `PUT /ITILSolution/:id` (S1.5 / M3) |

### Códigos de erro `401` e `403`

- `401 ERROR_APP_TOKEN_PARAMETERS_MISSING`: cabeçalho `App-Token` ausente.
- `401 ERROR_WRONG_APP_TOKEN_PARAMETER`: cabeçalho `App-Token` incorreto.
- `401 ERROR_LOGIN_PARAMETERS_MISSING`: cabeçalho `Authorization` ausente ou malformado em `/initSession`.
- `401 ERROR_GLPI_LOGIN`: login ou senha inválidos no esquema `Basic`.
- `401 ERROR_GLPI_LOGIN_USER_TOKEN`: token inválido no esquema `user_token`.
- `401 ERROR_SESSION_TOKEN_MISSING`: cabeçalho `Session-Token` ausente.
- `401 ERROR_SESSION_TOKEN_INVALID`: `Session-Token` inexistente ou já encerrado por `/killSession`.
- `403 ERROR_RIGHT_MISSING`: perfil autenticado sem permissão para a ação da rota.

Toda resposta `401` ou `403` é gravada na tabela `access_denials` do SQLite (protegida por triggers `BEFORE UPDATE` e `BEFORE DELETE` append-only) com `occurred_at` em UTC ISO 8601 (`Z`), `status`, `error_code`, `user_id`, `login`, `profile`, `action`, `method`, `url`, `ticket_id` e `origin_ip`, além de linha `warn` no log do Fastify (sem expor senhas ou tokens).

## Container (S1.7 · #22)

Build na **raiz do repositório** (o `package-lock.json` é do monorepo):

```bash
docker build -f apps/system-a/Dockerfile -t system-a .
docker run -d --env-file .env -p 3001:3001 -v system-a-data:/data system-a
curl http://localhost:3001/health   # {"status":"ok"}
```

- Imagem multi-stage (`node:20-bookworm-slim`), processo como usuário `node` (não root) e código somente leitura; o único diretório gravável é `/data` (SQLite em `/data/system-a.db`).
- `NODE_ENV=production` é fixo na imagem: sem as 4 credenciais (`A_APP_TOKEN`, `A_TECNICO_PASSWORD`, `A_ESTAGIARIO_PASSWORD`, `A_SYNC_BOT_TOKEN`) o container não sobe. Nenhuma credencial vai na imagem.
- `GET /health` (sem autenticação, fora de `/apirest.php`) confere o SQLite; é usado pelo `HEALTHCHECK`.
- `SIGTERM`/`SIGINT` fecham o servidor e o banco e saem com código 0.
- Smoke local: `bash infra/scripts/smoke-system-a.sh system-a`.
- No Windows o `shutdown.test.js` é pulado (SIGTERM mata o processo sem handler); a CI (Linux) roda.

## Webhook `ticket.changed` (S1.3 · #18)

Quando `A_WEBHOOK_ENABLED=true`, toda criação (`POST /apirest.php/Ticket`) ou edição (`PUT /apirest.php/Ticket/:id`) concluída com sucesso dispara um `POST` assíncrono para `A_WEBHOOK_URL` (**exceto** mudanças cujo ator na sessão tem perfil `sync-bot`, barreira 2 do anti-eco — ADR-009).

- **Sinal, nunca dado (ADR-005):** o corpo segue [`contracts/events/ticket-changed.schema.json`](../../contracts/events/ticket-changed.schema.json) (`schema_version: 1`, `event_id` UUID por disparo, `type: "ticket.changed"`, `ticket_id`, `action: "created" | "updated"`, `occurred_at` em UTC sem milissegundos e `date_mod` salvo no fuso do A). O sincronizador usa apenas `ticket_id` e relê o estado atual no A.
- **Assinatura HMAC-SHA256 + timestamp (`X-Timestamp` e `X-Signature-256`):** o corpo JSON é serializado uma única vez (`rawBody`) e assinado sobre `"<X-Timestamp>.<rawBody>"` com `HMAC_SECRET`.
- **Verificação no receptor (S3.4):** ler o **corpo cru** (sem reserializar), validar a janela anti-replay de 5 min sobre `X-Timestamp` e comparar em tempo constante:
  ```js
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`, 'utf8').digest('hex');
  const ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  ```
- **Fire-and-forget e modo "perder X%":** o handler HTTP responde imediatamente sem esperar o envio; cada disparo tem timeout de `2000 ms` e não faz retry (qualquer falha vira `warn` no log, sem expor o segredo nem a assinatura). Quando `A_WEBHOOK_DROP_RATE` está entre `0` e `100`, `X%` dos eventos são sorteados e descartados após montar o evento (`info` com `event_id`), permitindo provar que o poller recupera chamados sem perder atualização (cenário B2).

## Endpoints implementados (S1.1 · #16, S1.2 · #17 e S1.7 · #22)

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/apirest.php/initSession` | Autentica `Basic` (`tecnico`/`estagiario`) ou `user_token` (`sync-bot`) e devolve `{ "session_token": "..." }` (`200`) |
| `GET` | `/apirest.php/killSession` | Invalida o `Session-Token` atual (`200`) |
| `POST` | `/apirest.php/Ticket` | Cria chamado a partir de `{ "input": { ... } }` (`201`). `name` e `content` obrigatórios; `status` assume `1`, `priority` assume `3` e `users_id_recipient` assume o usuário da sessão quando omitidos |
| `GET` | `/apirest.php/Ticket/:id` | Lê chamado por ID (`200`) ou retorna `404` `["ERROR_ITEM_NOT_FOUND", "..."]` |
| `GET` | `/apirest.php/Ticket` | Lista chamados com `range=<início>-<fim>` (padrão `0-49`, máx. `500`), `sort=date_mod\|id`, `order=ASC\|DESC` e filtro opcional `date_mod_gte=YYYY-MM-DD HH:MM:SS`. Retorna cabeçalho `Content-Range` (`200` ou `206`) |
| `GET` | `/health` | Saúde do Sistema A, sem autenticação (`200 {"status":"ok"}` ou `503`) |
| `PUT` | `/apirest.php/Ticket/:id` | Atualiza campos parciais via `{ "input": { ... } }`, recalcula `date_mod` no fuso `A_TIMEZONE` e emite o evento interno `ticket.changed` com `{ ticketId, action, dateMod, actor }` |

Erros seguem o formato do GLPI: `["ERROR_CODIGO", "Mensagem legível"]`.

## Simplificações em relação ao GLPI real

- **Filtro `date_mod_gte` na própria listagem (`GET /Ticket`):** substitui a query de IDs numéricos de campo do `/search/Ticket` do GLPI. Como `date_mod` tem formato fixo `YYYY-MM-DD HH:MM:SS` no fuso `A_TIMEZONE`, a comparação é textual e inclusiva (`date_mod >= valor`).
- **Dropdowns como IDs:** `itilcategories_id`, `locations_id`, `users_id_recipient` e `users_id_assign` trafegam como inteiros (`>= 1` ou `null`); o de-para fica no serviço de sincronização.
- **Defaults de domínio na criação:** `status = 1` (Novo), `priority = 3` (Média) e `users_id_recipient = <id da sessão>` quando omitidos no `POST /Ticket`.
- **Sessão e segurança do mock:** sessões ficam no SQLite sem expiração automática (encerradas via `/killSession`); não há tela de gestão de usuários (trocar a senha no ambiente e reiniciar atualiza o hash no seed); não há rate-limit/bloqueio de força bruta (risco conhecido de mock de demonstração, mitigado pelo registro de todas as tentativas em `access_denials`); as negações ficam no SQLite e no log do A (a linha do tempo unificada de auditoria entra na M2).
- **Webhook sem fila nem retry no A:** não há retentativa local no Sistema A porque o polling periódico com sobreposição é a garantia de entrega (ADR-005, cenário B2); o descarte de `A_WEBHOOK_DROP_RATE` é feito por sorteio uniforme em cada disparo.

## O que entra nas próximas issues do Épico E1

| Capacidade do contrato | Issue |
|---|---|
| Acompanhamentos (`/Ticket/:id/ITILFollowup` e `POST /ITILFollowup`) | **S1.4 (#19)** |
| Soluções (`ITILSolution`), preenchimento automático de `solvedate`/`closedate` e congelamento `409 ERROR_TICKET_FROZEN` nos status 5 e 6 | **S1.5 (#20)** |
| Interface web de operação do Sistema A | **S1.6 (#21)** |
