# Contratos

A **única** forma de os sistemas se conhecerem (ADR-001). Nenhum app importa código de outro.

- [`system-a.openapi.yaml`](system-a.openapi.yaml): API estilo GLPI (`Ticket`, `ITILFollowup`, `ITILSolution`, filtro `date_mod_gte` e webhook `ticket.changed`)
- [`system-b.openapi.yaml`](system-b.openapi.yaml): contrato mínimo do B + capacidades opcionais marcadas
- [`events/ticket-changed.schema.json`](events/ticket-changed.schema.json): evento do webhook do A (acompanhado de exemplos em `events/examples/{valid,invalid}/`)

## Convenções

- **Dialeto único:** OpenAPI **3.1.0** e JSON Schema **draft 2020-12** em todos os contratos.
- **`x-capability: <nome>`** no contrato do B: marca capacidades opcionais configuradas ou detectadas pelo sync (`B_SUPPORTS_COMMENTS`, `updatedBy`, `etag` — ADR-003, ADR-011). Um `grep -n "x-capability" contracts/*.yaml` lista tudo o que é opcional no B.
- **`x-optional: "B→A (M3)"`** no contrato do A: marca operações que pertencem ao retorno opcional B → A (`ITILSolution` POST/PUT).
- **Prova do ADR-003:** o que **não** está descrito em `system-b.openapi.yaml` (busca por referência externa, `Idempotency-Key`, webhooks do B, soft delete, timestamps confiáveis) **não pode ser usado** pelo `sync-service`.
- **Evento é sinal (ADR-005):** `ticket-changed.schema.json` é fechado (`additionalProperties: false`) com `schema_version: 1`; o sincronizador usa apenas `ticket_id` e sempre lê o estado atual do A.

## Como validar

```bash
npm run lint:contracts
```

Executa em sequência:
- `npm run lint:openapi`: valida `system-a.openapi.yaml` e `system-b.openapi.yaml` com o **Redocly CLI** (`redocly.yaml`, regras `recommended`, incluindo o `$ref` externo do webhook).
- `npm run lint:events`: compila `events/ticket-changed.schema.json` com o **Ajv CLI** (draft 2020-12 + `ajv-formats`), garante que todos os exemplos em `events/examples/valid/*.json` passam e que todos os exemplos em `events/examples/invalid/*.json` são rejeitados.

## Como mudar

- **Contrato primeiro:** qualquer alteração de rota, campo ou evento entra em `contracts/` antes (ou no mesmo PR) da story que a implementa ou consome, validada pelo job `contracts` da CI.
- **Mudança de premissa:** alterar uma suposição sobre o Sistema B ou sobre as garantias exige registrar um **ADR novo** em `docs/adr/` antes de editar o contrato.
