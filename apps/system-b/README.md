# Sistema B: caixa-preta instável (C# / .NET 8)

O sistema externo em que **não confiamos**. Implementa **apenas o contrato mínimo** (criar, ler por ID, atualizar por ID, listar), com formato de dados próprio, para provar que o sync não depende de recursos do B:

- **sem** busca por referência externa e **sem** `Idempotency-Key`;
- **caos configurável**: latência, 5xx, timeout, "grava e devolve erro", "devolve sucesso e não grava", 200 com corpo de erro, 429, texto truncado, paginação instável e drift de formato;
- comentários, autor da alteração e ETag como **capacidades opcionais** (desligáveis).

O projeto mira `net8.0`; o `global.json` aceita SDKs mais novos (`rollForward: latestMajor`).

Contrato: [`contracts/system-b.openapi.yaml`](../../contracts). Issues: épico **E2**.
