# Sistema B: caixa-preta instável (C# / .NET 8)

O sistema externo em que **não confiamos**. Implementa **apenas o contrato mínimo** (criar, ler por ID, atualizar por ID, listar), com formato de dados próprio, para provar que o sync não depende de recursos do B:

- **sem** busca por referência externa e **sem** `Idempotency-Key`;
- **caos configurável** (S2.2): latência, 5xx, timeout, "grava e devolve erro", "devolve sucesso e não grava", 200 com corpo de erro, 429, texto truncado, paginação instável e drift de formato;
- comentários, autor da alteração e ETag como **capacidades opcionais** (desligáveis).

O projeto mira `net8.0`; o `global.json` aceita SDKs mais novos (`rollForward: latestMajor`).

Contrato: [`contracts/system-b.openapi.yaml`](../../contracts/system-b.openapi.yaml). Issues: épico **E2**.

## Como rodar

```bash
dotnet run --project apps/system-b/src/SystemB.Api   # http://0.0.0.0:5002
dotnet test apps/system-b                            # testes xUnit (mesmo comando da CI)
```

| Variável | Padrão | Para quê |
|---|---|---|
| `ASPNETCORE_URLS` | `http://0.0.0.0:5002` | Endereço e porta |
| `B_DB_PATH` | `./data/system-b.db` | Arquivo SQLite (os registros sobrevivem a reinício) |
| `B_ADMIN_TOKEN` | _(vazio = admin desligado)_ | Token das rotas `/admin` |
| `B_CHAOS_*` | tudo desligado | Caos (seção abaixo) |

## Caos (S2.2)

O caos vale **só para `/api/v2`** (a API que o sync usa). `/health`, `/operator`, `/admin` e a UI ficam fora, para a demo continuar operável.

Cada requisição faz **um sorteio** e cai em no máximo uma falha, por isso a soma das taxas de falha não pode passar de 1. Com `seed`, a mesma sequência de requisições produz as mesmas decisões (reprodutível na CI e na demo); reconfigurar com a mesma seed recomeça a sequência.

| Variável (`B_CHAOS_*`) | Campo no `/admin/chaos` | O que faz | Cenário |
|---|---|---|---|
| `SEED` | `seed` | Semente do sorteio (vazio = aleatório) | todos |
| `LATENCY_MS` | `latencyMs` | Atraso fixo em toda requisição | E |
| `ERROR_RATE` | `errorRate` | 500 ou 503 **sem gravar** | B1 |
| `TIMEOUT_RATE` / `TIMEOUT_MS` | `timeoutRate` / `timeoutMs` (padrão 30000) | Segura a resposta além do timeout do cliente e **grava depois** | A2 |
| `COMMIT_THEN_FAIL_RATE` | `commitThenFailRate` | **Grava** e devolve 500 (só POST/PUT) | A1 |
| `ACK_WITHOUT_PERSIST_RATE` | `ackWithoutPersistRate` | Devolve 201/200 **sem gravar**; o ID devolvido no POST não existe (só POST/PUT) | B5 |
| `OK_WITH_ERROR_BODY_RATE` | `okWithErrorBodyRate` | Executa de verdade e devolve **200 com corpo de erro** | A3 |
| `RATE_LIMIT_RATE` | `rateLimitRate` | 429 com `Retry-After: 1`, sem gravar | E |
| `TRUNCATE_TEXT` | `truncateText` | Corta `description` em N caracteres ao gravar (0 = desliga); o marcador no fim some | S3.7 |
| `PAGE_REPEAT_RATE` / `PAGE_SKIP_RATE` | `pageRepeatRate` / `pageSkipRate` | Listagem desloca o offset: repete o último item da página anterior ou pula um | A7, S3.9 |
| `LIST_DELAY_MS` | `listDelayMs` | Registro recém-criado só aparece na listagem depois de N ms (o GET por ID já acha) | A7 |

Valor inválido nas variáveis derruba a subida (falha rápido).

### Admin do caos

Exige `X-Admin-Token` igual a `B_ADMIN_TOKEN` (comparação em tempo constante). Sem `B_ADMIN_TOKEN`, as rotas `/admin` respondem 403.

| Rota | Efeito |
|---|---|
| `GET /admin/chaos` | Configuração atual |
| `PUT /admin/chaos` | Substitui a configuração inteira (campo ausente = 0/desligado). 422 se uma taxa sair de 0–1 ou a soma passar de 1; 400 para campo desconhecido |
| `POST /admin/chaos/reset` | Volta para o que veio das variáveis `B_CHAOS_*` |

```bash
curl -s -X PUT $B/admin/chaos -H "X-Admin-Token: $B_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"seed":42,"errorRate":0.2,"timeoutRate":0.05,"timeoutMs":8000,"commitThenFailRate":0.05}'
curl -s -X POST $B/admin/chaos/reset -H "X-Admin-Token: $B_ADMIN_TOKEN"
```

## Container (S2.6)

```bash
docker build -t system-b apps/system-b                                       # contexto é a pasta do B
docker run -d -p 5002:5002 -v system-b-data:/data system-b
bash infra/scripts/smoke-system-b.sh system-b                               # mesmo smoke da CI
docker buildx build --platform linux/amd64,linux/arm64 apps/system-b        # imagem ARM e x64
```

- **Multi-stage:** o SDK compila na arquitetura de quem faz o build (`--platform=$BUILDPLATFORM`) e publica para a de destino (`-a $TARGETARCH`). O estágio final não tem `RUN`, então o arm64 sai sem emulação.
- **Sem root:** roda como `APP_UID` (1654) das imagens oficiais; `/app` é somente leitura e os dados ficam no volume `/data`.
- **Healthcheck sem curl:** a imagem `aspnet` não tem curl, então o `HEALTHCHECK` chama o próprio binário com `--healthcheck`, que consulta `/health` e sai com 0 ou 1.
- A CI roda `dotnet test`, builda a imagem, executa o smoke (não-root, healthy, criar/listar, dado e marcador sobrevivem a restart, parada limpa, `/app` somente leitura) e faz o build multi-arquitetura.

## Rotas (S2.1)

| Método e rota | Resposta |
|---|---|
| `POST /api/v2/records` | 201 + `Record` + cabeçalho `Location` |
| `GET /api/v2/records/{id}` | 200 `Record` · 404 |
| `PUT /api/v2/records/{id}` | 200 `Record` (substituição completa) · 404 |
| `GET /api/v2/records?page&pageSize` | 200 `RecordPage` (`page` ≥ 1, `pageSize` 1–200, padrão 1 e 50) |
| `DELETE /operator/records/{id}` | 204 · 404 (exclusão física pelo operador) |
| `GET /health` | 200 `{ "status": "ok" }` |

Erros sempre `{ "error": "...", "message": "..." }`:

- **400** `BAD_REQUEST`: JSON malformado, tipo errado, enum inválido, campo desconhecido (inclui `id`, `createdAt`, `updatedBy`), `page`/`pageSize` inválidos;
- **422** `VALIDATION_ERROR`: `title` vazio ou com mais de 200 caracteres (após trim), `lat`/`lng` fora da faixa, `sha256` fora do padrão, `size` negativo;
- **404** `NOT_FOUND`: registro ou rota inexistente.

`description` é guardada e devolvida exatamente como recebida (inclusive `⟦s:glpi-42⟧` e quebras de linha). `title` recebe trim.

## O que não existe, de propósito

- **Busca por referência**: parâmetros como `externalId`, `search`, `ref` e `q` na listagem são ignorados; não há rota de busca.
- **`Idempotency-Key`**: o cabeçalho é ignorado; dois POSTs iguais criam dois registros.
- **DELETE na API do sync**: `DELETE /api/v2/records/{id}` não existe (ADR-003). A exclusão fica em `/operator/records/{id}`, fora de `/api/v2` e fora do contrato, para a futura UI do Operador B. Para o sync, excluído e perdido parecem iguais (404) e quem decide é uma pessoa (ADR-007).
- Webhooks e autenticação.

## Ainda não implementado

| O quê | Issue |
|---|---|
| Comentários (`B_SUPPORTS_COMMENTS`) | S2.3 (#25) |
| UI do Operador B | S2.4 (#26) |
| Admin, wipe e drift com token | S2.5 (#27) |
| `updatedBy`, ETag e `If-Match` (hoje `If-Match` é ignorado) | S2.7 (#128) |

## Exemplos

```bash
B=http://localhost:5002
curl -s -X POST $B/api/v2/records -H 'Content-Type: application/json' -d '{
  "title":"Impressora do 3º andar não imprime",
  "description":"A impressora parou.\n\n⟦s:glpi-42⟧",
  "state":"IN_PROGRESS","severity":"HIGH"}'
curl -s $B/api/v2/records/B-1
curl -s -X PUT $B/api/v2/records/B-1 -H 'Content-Type: application/json' -d '{
  "title":"Impressora ok","description":"Resolvido","state":"RESOLVED","severity":"LOW"}'
curl -s "$B/api/v2/records?page=1&pageSize=50"
curl -s -X DELETE $B/operator/records/B-1 -i   # 204; depois o GET devolve 404
```
