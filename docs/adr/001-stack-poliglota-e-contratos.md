# ADR-001: Stack poliglota (A JS, B C#, Sync TS) e comunicação só por contratos

- **Status:** Aceito
- **Data:** 16/10/2026
- **Decisões do plano:** Stack (seção 2) e Estrutura de pastas (seção 3 do `PLANO_DE_ACAO.md`)

## Contexto
O desafio envolve integrar dois sistemas de donos diferentes: o Sistema A (estilo GLPI) e o Sistema B ("outra API, outro formato", caixa-preta e não confiável). Precisamos provar de forma inequívoca que o serviço de sincronização não depende de código interno, tipos compartilhados ou banco de dados de nenhum dos dois lados.

## Decisão
- **Sistema A (Mock GLPI):** Node.js + JavaScript (`apps/system-a`), com seu próprio banco SQLite.
- **Sistema B (Caixa-preta instável):** C# / .NET 8 (`apps/system-b`), em runtime e linguagem distintos do sincronizador.
- **Sync Service:** Node.js + TypeScript (`apps/sync-service`), com banco PostgreSQL próprio.
- Cada aplicação roda em seu próprio processo e possui armazenamento isolado; a comunicação ocorre exclusivamente via HTTP, documentada em `contracts/` (`system-a.openapi.yaml`, `system-b.openapi.yaml` e `events/ticket-changed.schema.json`).
- O repositório único (monorepo) organiza `apps/system-a`, `apps/sync-service` e `tests/e2e` via npm workspaces na raiz e fixa o SDK do `apps/system-b` via `global.json`.

## Consequências
- **Fica mais fácil:** garantir isolamento real (impossível importar classes ou modelos entre o Sync em TS e o Sistema B em C#); demonstrar que o Sistema B se comporta de fato como um sistema de terceiro.
- **Fica mais difícil:** manter duas toolchains (Node.js e .NET 8) no mesmo repositório e na CI — mitigado pela detecção de mudanças por pasta (`dorny/paths-filter` na S0.2).
- **Risco que sobra:** divergência entre o contrato documentado em `contracts/` e a implementação de cada app, mitigada pelos testes de integração e E2E contra o `docker-compose`.

## Alternativas consideradas
| Alternativa | Por que não |
|---|---|
| Tudo em TypeScript | Mais rápido de configurar, mas o mock do B ficaria parecido demais com o sync e abriria margem para acoplamento acidental. |
| Subir o GLPI real em PHP/MariaDB | Pesado para subir nos testes E2E e hospedar gratuitamente junto com os demais serviços dentro do prazo do desafio. |
| Banco de dados compartilhado entre os sistemas | Quebra a premissa central do problema (dois sistemas independentes e B como caixa-preta). |

## Onde está no código / como provar
- Pastas independentes em `apps/system-a`, `apps/system-b` e `apps/sync-service`.
- Contratos formais em `contracts/` (S0.4 / #15).
- Pipeline `.github/workflows/ci.yml` com jobs separados por toolchain (S0.2 / #13).
