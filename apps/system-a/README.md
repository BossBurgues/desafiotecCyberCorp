# Sistema A: mock do GLPI (Node.js + JavaScript)

A **fonte da verdade** dos chamados (ADR-001, ADR-005). Imita a API REST do GLPI 10 nos pontos que importam para a sincronização:

- status `1`–`6` (Novo, Em atendimento, Planejado, Pendente, Solucionado, Fechado) e prioridade `1`–`6`;
- categoria (`itilcategories_id`), localização (`locations_id`), requerente (`users_id_recipient`) e atribuído (`users_id_assign`) como IDs numéricos;
- `date` e `date_mod` **sem fuso horário** (`YYYY-MM-DD HH:MM:SS`), formatados no fuso do servidor (`A_TIMEZONE`); não há campo de versão nem `ETag`;
- persistência em SQLite (`better-sqlite3`), com ordenação estável por `(date_mod, id)`.

Contrato: [`contracts/system-a.openapi.yaml`](../../contracts/system-a.openapi.yaml). Issues: épico **E1**.

## Como rodar e testar

Na raiz do monorepo:

```bash
npm ci
npm run test -w apps/system-a
npm run start -w apps/system-a
```

### Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3001` | Porta HTTP do servidor Fastify (prefixo `/apirest.php`) |
| `A_TIMEZONE` | `America/Sao_Paulo` | Fuso usado para formatar `date` e `date_mod` sem offset (ADR-005) |
| `A_DB_PATH` | `./data/system-a.db` | Caminho do arquivo SQLite (`:memory:` em testes) |

## Endpoints implementados (S1.1 · #16)

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/apirest.php/Ticket` | Cria chamado a partir de `{ "input": { ... } }` (`201`). Na criação, `name` e `content` são obrigatórios; `status` assume `1` (Novo) e `priority` assume `3` quando omitidos |
| `GET` | `/apirest.php/Ticket/:id` | Lê chamado por ID (`200`) ou retorna `404` `["ERROR_ITEM_NOT_FOUND", "..."]` |
| `GET` | `/apirest.php/Ticket` | Lista chamados com `range=<início>-<fim>` (padrão `0-49`, máx. `500`), `sort=date_mod\|id`, `order=ASC\|DESC` e filtro opcional `date_mod_gte=YYYY-MM-DD HH:MM:SS`. Retorna cabeçalho `Content-Range` (`200` lista completa ou vazia fora da faixa; `206` lista parcial) |
| `PUT` | `/apirest.php/Ticket/:id` | Atualiza campos parciais via `{ "input": { ... } }`, recalcula `date_mod` no fuso `A_TIMEZONE` e emite o evento interno `ticket.changed` após gravar no SQLite |

Erros seguem o formato do GLPI: `["ERROR_CODIGO", "Mensagem legível"]` (`ERROR_INVALID_INPUT` para `400`, `ERROR_ITEM_NOT_FOUND` para `404`).

## Simplificações em relação ao GLPI real

- **Filtro `date_mod_gte` na própria listagem (`GET /Ticket`):** substitui a query de IDs numéricos de campo do `/search/Ticket` do GLPI. Como `date_mod` tem formato fixo `YYYY-MM-DD HH:MM:SS` no fuso `A_TIMEZONE`, a comparação é textual e inclusiva (`date_mod >= valor`).
- **Dropdowns como IDs:** `itilcategories_id`, `locations_id`, `users_id_recipient` e `users_id_assign` trafegam como inteiros (`>= 1` ou `null`); o de-para fica no serviço de sincronização.
- **Defaults de domínio na criação:** `status = 1` (Novo) e `priority = 3` (Média) quando omitidos no `POST /Ticket`.

## O que entra nas próximas issues do Épico E1

| Capacidade do contrato | Issue |
|---|---|
| Sessão (`/initSession`, `/killSession`), cabeçalhos `App-Token`/`Session-Token`, perfis (`tecnico`, `estagiario`, `sync-bot`) e respostas `401`/`403` | **S1.2 (#17)** |
| Disparo HTTP do webhook `ticket.changed` com assinatura HMAC-SHA256 e `A_WEBHOOK_DROP_RATE` | **S1.3 (#18)** |
| Acompanhamentos (`/Ticket/:id/ITILFollowup` e `POST /ITILFollowup`) | **S1.4 (#19)** |
| Soluções (`ITILSolution`), preenchimento automático de `solvedate`/`closedate` e congelamento `409 ERROR_TICKET_FROZEN` nos status 5 e 6 | **S1.5 (#20)** |
| Interface web de operação do Sistema A | **S1.6 (#21)** |
| Dockerfile e suíte final do container do Sistema A | **S1.7 (#22)** |
