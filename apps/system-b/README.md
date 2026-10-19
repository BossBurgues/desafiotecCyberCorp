# Sistema B: caixa-preta instável (C# / .NET 8)

O sistema externo em que **não confiamos**. Pelo PDF, ele **recebe** os chamados do Sistema A (o central) e precisa ficar atualizado. Implementa **apenas o contrato mínimo** (criar, ler por ID, atualizar por ID, listar), com formato de dados próprio, para provar que o sync não depende de recursos do B:

- **sem** busca por referência externa e **sem** `Idempotency-Key`;
- **caos configurável** (S2.2): latência, 5xx, timeout, "grava e devolve erro", "devolve sucesso e não grava", 200 com corpo de erro, 429, texto truncado, paginação instável e drift de formato;
- **quem alterou** (`updatedBy`, definido pelo servidor: o operador pelo cabeçalho `X-Operator`, ou "integração (sync)") e **texto da solução** (`resolution`) como capacidades opcionais, usadas pelo B → A leve (ADR-014). Comentários e ETag não foram implementados.

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

## UI do Operador B (S2.4)

`http://localhost:5002/ui/`: a tela do operador do sistema de terceiro. Ele vê o que chegou do A (com o marcador `⟦s:glpi-<id>⟧`), informa o próprio nome (vai para o A como "quem alterou") e pode resolver, fechar e reabrir com um texto de solução: com o B → A leve, isso **volta ao A** em até 30 s. Editar outros campos é desfeito pelo A (fonte da verdade), e excluir faz o sync recriar o registro a partir do A. Sem papéis nem login (o B é caixa-preta).

- Usa as rotas `/operator/records`, que ficam fora do contrato e **fora do caos**: a demo continua operável com o caos ligado.
- Mostra o chamado do A ligado ao registro (lido do marcador `⟦s:glpi-<id>⟧`). Editar a descrição pode apagar o marcador de propósito. Hoje, a próxima alteração no A regrava a descrição com o marcador; o auditor que regravaria sozinho (S3.9) ficou fora do escopo.
- O `PUT` é substituição completa, então a UI parte do registro atual e preserva localização, anexos e `sourceUpdatedAt`.
- Mesmas regras da UI do A: lista fechada de arquivos, CSP `default-src 'self'` e nenhum HTML montado a partir de texto (teste `Nenhum_arquivo_da_UI_monta_HTML_a_partir_de_texto`).
- **Comentar** dependia da capacidade de comentários do B (S2.3, #25), fora do escopo.

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
| `FORMAT_DRIFT` | `formatDrift` | `true`: as respostas 2xx de `/api/v2/records` trocam `title` por `summary` (no registro e em cada item da página). O dado gravado não muda | E1 |

Valor inválido nas variáveis derruba a subida (falha rápido).

### Admin (caos, drift, perda de dados)

Exige `X-Admin-Token` igual a `B_ADMIN_TOKEN` (comparação em tempo constante). Sem `B_ADMIN_TOKEN`, as rotas `/admin` respondem 403.

| Rota | Efeito |
|---|---|
| `GET /admin/chaos` | Configuração atual |
| `PUT /admin/chaos` | Substitui a configuração inteira (campo ausente = 0/desligado). 422 se uma taxa sair de 0–1 ou a soma passar de 1; 400 para campo desconhecido |
| `POST /admin/chaos/reset` | Volta para o que veio das variáveis `B_CHAOS_*` |
| `DELETE /admin/records/{id}` | 204 · 404. Apaga um registro como se o B o tivesse perdido (S2.5) |
| `POST /admin/wipe` | 200 `{ "deleted": n }`. Apaga todos os registros (S2.5) |

Depois de um wipe, os IDs **não são reaproveitados** (`AUTOINCREMENT`): um `b_record_id` antigo no mapeamento do sync dá 404, nunca aponta para outro chamado. O drift de formato é ligado pelo `/admin/chaos` (`formatDrift`) e desligado com `PUT /admin/chaos {}` ou `/admin/chaos/reset`.

```bash
curl -s -X PUT $B/admin/chaos -H "X-Admin-Token: $B_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"seed":42,"errorRate":0.2,"timeoutRate":0.05,"timeoutMs":8000,"commitThenFailRate":0.05}'
curl -s -X POST $B/admin/chaos/reset -H "X-Admin-Token: $B_ADMIN_TOKEN"
curl -s -X PUT $B/admin/chaos -H "X-Admin-Token: $B_ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"formatDrift":true}'
curl -s -X DELETE $B/admin/records/B-1 -H "X-Admin-Token: $B_ADMIN_TOKEN" -i
curl -s -X POST $B/admin/wipe -H "X-Admin-Token: $B_ADMIN_TOKEN"
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
| `GET/PUT /operator/records[/{id}]` | Mesmas respostas da API, **sem caos** (usadas pela UI do operador) |
| `DELETE /operator/records/{id}` | 204 · 404 (exclusão física pelo operador) |
| `/admin/*` | Caos, drift, apagar registro e wipe, com `X-Admin-Token` (seção Admin) |
| `GET /ui/` | UI do Operador B |
| `GET /health` | 200 `{ "status": "ok" }` |

Erros sempre `{ "error": "...", "message": "..." }`:

- **400** `BAD_REQUEST`: JSON malformado, tipo errado, enum inválido, campo desconhecido (inclui `id`, `createdAt`, `updatedBy`), `page`/`pageSize` inválidos;
- **422** `VALIDATION_ERROR`: `title` vazio ou com mais de 200 caracteres (após trim), `lat`/`lng` fora da faixa, `sha256` fora do padrão, `size` negativo;
- **404** `NOT_FOUND`: registro ou rota inexistente.

`description` é guardada e devolvida exatamente como recebida (inclusive `⟦s:glpi-42⟧` e quebras de linha). `title` recebe trim.

## O que não existe, de propósito

- **Busca por referência**: parâmetros como `externalId`, `search`, `ref` e `q` na listagem são ignorados; não há rota de busca.
- **`Idempotency-Key`**: o cabeçalho é ignorado; dois POSTs iguais criam dois registros.
- **DELETE na API do sync**: `DELETE /api/v2/records/{id}` não existe (ADR-003). A exclusão fica em `/operator/records/{id}`, fora de `/api/v2` e fora do contrato, usada pela UI do Operador B. Para o sync, excluído e perdido parecem iguais (404) e quem decide é uma pessoa (ADR-007).
- Webhooks e autenticação.

## Ainda não implementado

| O quê | Issue |
|---|---|
| Comentários (`B_SUPPORTS_COMMENTS`) | S2.3 (#25) |
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
