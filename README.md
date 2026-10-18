# Sincronizador de chamados

Serviço que mantém os chamados de um sistema estilo **GLPI (Sistema A)** sincronizados em um **sistema externo instável (Sistema B)**, entregue como se fosse para produção.

> **Status:** 🚧 em construção · M0 Fundação. Acompanhe no [Project](https://github.com/users/BossBurgues/projects/2).

## As três proibições

Todo o projeto existe para garantir que **nunca**:

1. haja um chamado duplicado no Sistema B;
2. uma atualização se perca;
3. um dado antigo sobrescreva um dado mais novo.

## Monorepo poliglota

Os três sistemas são escritos em linguagens diferentes **de propósito**: o sync não pode depender de como o outro lado é feito. Eles conversam **somente por HTTP**, seguindo os contratos em [`contracts/`](contracts/).

| Pasta | O que é | Stack |
|---|---|---|
| [`apps/system-a`](apps/system-a) | Sistema A: mock do GLPI, a fonte da verdade | Node.js + JavaScript |
| [`apps/system-b`](apps/system-b) | Sistema B: caixa-preta instável, com caos configurável | C# / .NET 8 |
| [`apps/sync-service`](apps/sync-service) | ⭐ Sync Service: o que é avaliado | Node.js + TypeScript |
| [`contracts`](contracts) | Contratos OpenAPI e schema de eventos | YAML / JSON Schema |
| [`tests/e2e`](tests/e2e) | Catálogo de cenários de caos contra o ambiente completo | Node.js |
| [`infra`](infra) | Docker Compose, Caddy, scripts de deploy | Docker |
| [`docs`](docs) | Plano, ADRs, arquitetura, runbook, timelog | Markdown + Mermaid |

```
.
├── apps/
│   ├── system-a/        # Node/JS
│   ├── system-b/        # C#/.NET
│   └── sync-service/    # Node/TS
├── contracts/
├── tests/e2e/
├── infra/
└── docs/
```

## Como rodar

> Os comandos abaixo passam a funcionar conforme as issues de cada app são entregues.

```bash
npm install          # workspaces Node (system-a, sync-service, e2e)
npm test             # testes de todos os workspaces Node
npm run test:b       # testes do Sistema B (.NET)
```

O ambiente completo vai subir com `docker compose -f infra/docker-compose.yml up` (issue S4.1).

## Documentação

- [Plano de ação completo](docs/PLANO_DE_ACAO.md): decisões, arquitetura, garantias e catálogo de cenários
- [ADRs](docs/adr/): por que cada decisão foi tomada
- [Registro de horas](docs/timelog.md)
- [Como contribuir](CONTRIBUTING.md)

## Escopo

- **Obrigatório:** A → B com as três garantias, publicado em URL, com documentação.
- **Opcional (em andamento se houver tempo):** retorno B → A no modelo *"o B propõe, o A aprova"*, com anti-eco e tratamento de concorrência.
