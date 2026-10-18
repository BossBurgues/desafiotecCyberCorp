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
| Caos | S2.2 (#24) |
| Comentários (`B_SUPPORTS_COMMENTS`) | S2.3 (#25) |
| UI do Operador B | S2.4 (#26) |
| Admin, wipe e drift com token | S2.5 (#27) |
| Dockerfile e smoke do container | S2.6 (#28) |
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
