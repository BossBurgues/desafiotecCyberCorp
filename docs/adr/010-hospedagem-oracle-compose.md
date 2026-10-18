# ADR-010: Hospedagem Oracle + Compose; plano B Render + Neon

- **Status:** Aceito
- **Data:** 16/10/2026
- **Decisões do plano:** Hospedagem e CI/CD (seções 2 e 14.2 do `PLANO_DE_ACAO.md`)

## Contexto
O desafio pede o projeto publicado em URL acessível com HTTPS, rodando Sistema A, Sistema B, Sync Service e PostgreSQL com workers em background contínuos (poller, fila e auditor), além de homologação (`Dev`) e produção (`Prod`), sem custo e dentro do prazo de uma semana.

## Decisão
- Hospedar na **VM Oracle Cloud Always Free (ARM Ampere)** usando **Docker Compose** e **Caddy** na frente para TLS/HTTPS automático.
- Publicar as imagens de container no **GitHub Container Registry (GHCR)**.
- Manter **dois projetos Compose isolados na mesma VM** (`cybercorp-dev` em `dev.<host>` e `cybercorp-prod` em `<host>`), cada um com seu próprio PostgreSQL, volumes e segredos em GitHub Environments (`development` e `production`).
- **Promoção imutável:** o merge na `Dev` constrói a imagem `dev-<sha>` e faz deploy em homologação; o merge de release na `Prod` (após aprovação manual no Environment `production`) **promove a mesma imagem já testada** (`retag` para `prod-<sha>` e `prod`, sem rebuild).
- **Plano B de contingência:** se houver indisponibilidade de provisionamento na região Oracle, publicar os serviços no **Render** conectados a um banco PostgreSQL no **Neon**.

## Consequências
- **Fica mais fácil:** rodar exatamente a mesma topologia `docker-compose` do ambiente local e da suíte E2E, sem *cold start* (sleep) que pausaria os workers em background.
- **Fica mais difícil:** as imagens Docker precisam suportar arquitetura ARM64 (ou multi-arch) e exigem configuração inicial da VM e SSH no deploy.
- **Risco que sobra:** falta de capacidade ARM no tier gratuito da Oracle no momento do provisionamento, coberto pelo Plano B (Render + Neon).

## Alternativas consideradas
| Alternativa | Por que não |
|---|---|
| Usar apenas PaaS gratuitos (Render / Fly.io) como plano principal | No tier gratuito os containers dormem por inatividade (interrompendo o poller/worker) ou têm limite curto de horas/bancos. |
| Kubernetes (k3s / EKS / GKE) | Complexidade operacional desproporcional para 4 containers em uma única VM; não agrega às garantias de sincronização. |
| Heroku | Não possui mais tier gratuito. |

## Onde está no código / como provar
- Arquivos em `infra/docker-compose.yml`, `infra/caddy/Caddyfile` e workflows de deploy (seção 14.2 do plano).
- Stories S4.3 (VM com dois ambientes) e S4.4 (deploy automático em homologação e com aprovação em produção).
