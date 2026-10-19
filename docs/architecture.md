# Arquitetura

Visão rápida dos componentes e dos fluxos que sustentam as três garantias: **nenhuma duplicata**, **nenhuma atualização perdida** e **dado antigo nunca sobrescreve novo**. O porquê de cada decisão está nos [ADRs](adr/README.md); o passo a passo pelo código fica em [`how-it-works.md`](how-it-works.md). Revisado em 19/10 para o escopo entregue: o núcleo A → B. O B → A está aqui só como **desenho** (seções marcadas).

## Componentes

```mermaid
flowchart LR
  subgraph A["Sistema A · Node/JS · mock GLPI"]
    direction TB
    A_UI["UI /ui<br/>Técnico · Estagiário"]
    A_API["REST /apirest.php<br/>Ticket · Followup · Solution"]
    A_WH["Webhook ticket.changed<br/>HMAC · modo perder X%"]
  end

  subgraph S["Sync Service · Node/TS"]
    direction TB
    HTTP["Fastify<br/>webhook · /health · /ready"]
    POLL["Poller do A<br/>sobreposição de 2 min"]
    W["Worker<br/>SKIP LOCKED · lease · backoff<br/>domínio puro: mapper · hash · fuso<br/>verificação pós-escrita"]
    DASH["Dashboard + /metrics<br/>login HTTP Basic · caos"]
    PG[("Postgres<br/>sync_jobs · ticket_mapping<br/>inbound_events · audit_log")]
  end

  subgraph B["Sistema B · C#/.NET 8 · caixa-preta"]
    direction TB
    CHAOS["Caos com seed<br/>só em /api/v2"]
    B_API["/api/v2/records<br/>contrato mínimo"]
    B_OP["UI /ui + /operator<br/>Operador B, sem caos"]
  end

  A_WH -- "sinal" --> HTTP
  POLL -- "GET por date_mod" --> A_API
  HTTP --> PG
  POLL --> PG
  PG --> W
  W -- "lê o estado atual" --> A_API
  W -- "create · PUT · GET · list" --> CHAOS
  DASH --> PG
  DASH -. "/admin/chaos (rede interna)" .-> B_API
  CHAOS --> B_API
  B_OP -.-> B_API
```

| Componente | Responsabilidade | Onde |
|---|---|---|
| Sistema A | Fonte da verdade. API estilo GLPI, perfis (Técnico, Estagiário, `sync-bot`), webhook assinado com modo "perder X%" | `apps/system-a` |
| Sistema B | Sistema externo em que **não confiamos**: só o contrato mínimo (ADR-003), formato próprio e caos reproduzível com seed | `apps/system-b` |
| Sync Service | Tudo o que é avaliado: entrada (webhook + poll), fila, worker, adaptadores, verificação pós-escrita, `audit_log` técnico e dashboard com login | `apps/sync-service` |
| Postgres | Fila e estado do sync na **mesma transação** (ADR-002) | serviço do compose |
| Contratos | OpenAPI do A e do B e schema do evento, independentes de linguagem | `contracts/` |

**Princípios que o desenho segue:**

- **O evento é só um sinal.** Webhook e poll só dizem "o chamado 42 mudou"; o worker sempre relê o A (ADR-005). Por isso eventos repetidos, atrasados ou fora de ordem não estragam nada.
- **Um job ativo por chamado.** Índice único parcial em `sync_jobs (ticket_id)` enquanto `pending`/`running`: repetições aglutinam e dois workers nunca escrevem o mesmo chamado ao mesmo tempo.
- **Idempotência sem ajuda do B.** Marcador `⟦s:glpi-<id>⟧` no texto + `ticket_mapping` + nunca reenviar um create às cegas (ADR-004).
- **Domínio puro.** Conversão, hash e fuso em `src/domain` sem I/O, com 100% de cobertura.

## Implantação

```mermaid
flowchart TB
  DEVS["Commits em milestone/*"] -- "PR" --> DEV["Dev<br/>ci.yml: testes, integração, E2E"]
  DEV -- "PR de release" --> PROD["Prod"]
  PROD --> DP["deploy-prod.yml<br/>build amd64 + arm64"]
  DP --> GHCR[("GHCR<br/>sha-&lt;7&gt; · prod")]
  DP -- "aprovação manual<br/>Environment production" --> SSH["SSH: troca IMAGE_TAG<br/>compose pull + up -d"]

  subgraph VM["VM Oracle Always Free · E2.1.Micro (x86, 1 GB + 2 GB swap)"]
    CADDY["Caddy · HTTPS Let's Encrypt<br/>a. · b. · sync.&lt;ip&gt;.sslip.io"]
    CADDY --> P1["system-a"] & P3["system-b"] & P2["sync-service"]
    P2 --- P4[("postgres")]
  end

  GHCR -- "pull" --> VM
  SSH --> VM
  SSH -- "smoke HTTPS" --> CADDY
```

Um único ambiente (revisão de 18/10): a `Dev` só roda a CI e a `Prod` publica. Rollback: `workflow_dispatch` com uma tag `sha-<7>` anterior, sem rebuild. A VM ARM (A1.Flex) estava sem capacidade na região, então a Micro x86 entrou no lugar; as imagens saem para as duas arquiteturas. Plano B: Render + Neon (ADR-010, `infra/README.md`).

## Fluxo A → B (núcleo)

```mermaid
sequenceDiagram
  autonumber
  participant A as Sistema A
  participant S as Sync (entrada)
  participant DB as Postgres
  participant W as Worker
  participant B as Sistema B

  A->>S: webhook ticket.changed (HMAC + timestamp)
  S->>DB: INSERT inbound_events + upsert sync_jobs (1 ativo por chamado)
  S-->>A: 200 só depois de gravar
  Note over S,DB: o poller faz o mesmo a cada 10 s:<br/>se o webhook se perder, nada se perde

  W->>DB: SELECT … FOR UPDATE SKIP LOCKED (lease em locked_until)
  W->>A: GET Ticket/42 (estado atual, nunca o payload do evento)
  W->>W: mapper + hash dos campos sincronizáveis
  alt hash = last_synced_hash
    W->>DB: job done (nada a fazer)
  else sem mapeamento
    W->>DB: intenção: create_uncertain (antes de chamar o B)
    W->>B: POST /records com ⟦s:glpi-42⟧ na description
    B-->>W: 201 B-7
    W->>B: GET /records/B-7 (verificação pós-escrita)
    W->>DB: ticket_mapping 42 → B-7 active + hashes + audit_log
  else já mapeado
    W->>B: PUT /records/B-7
    W->>B: GET /records/B-7 (verificação pós-escrita)
    W->>DB: last_synced_hash, last_written_hash, audit_log, job done
  end
  Note over W,B: leitura diferente do enviado → o hash não é gravado e o job volta (B5)<br/>404 → procura o marcador, adota ou recria depois de N varreduras
```

Falha **transitória** (timeout, 5xx, 429, rede) → backoff `1 s × 2ⁿ + jitter` até 5 min, por até 24 h. Falha **permanente** (400/422) → 3 tentativas e DLQ. Circuit breaker aberto → o job espera **sem gastar tentativas** (ADR-008).

## Falha ambígua no create (sem duplicar)

O B pode gravar e devolver erro, gravar e estourar o timeout, ou devolver 200 com corpo de erro (cenários A1, A2, A3). Reenviar o POST criaria um segundo registro.

```mermaid
sequenceDiagram
  autonumber
  participant W as Worker
  participant DB as Postgres
  participant B as Sistema B

  W->>B: POST /records (⟦s:glpi-42⟧)
  B--xW: 500 / timeout / 200 com corpo de erro
  W->>DB: ticket_mapping 42 = create_uncertain (sem b_record_id)
  loop até 2 varreduras completas (seção 10)
    W->>B: GET /records?page=n (listagem instável)
    alt achou ⟦s:glpi-42⟧ em B-7
      W->>DB: mapping 42 → B-7, state = active
      Note over W,DB: o registro que o B gravou é adotado: zero duplicatas
    end
  end
  alt não achou em nenhuma varredura
    W->>B: POST de novo (agora é seguro)
  end
  Note over W,B: o "modo seguro" (teste de capacidade do marcador na subida, S3.7)<br/>ficou fora do escopo: ver out-of-scope.md
```

## Fluxo B → A leve (implementado, ADR-014)

O operador do B resolve, fecha ou reabre; a varredura do B detecta pelo `last_written_hash`, o `processJob` compara com o `last_written_record`, aplica o status no A pelo `sync-bot` e escreve a nota com quem alterou e a solução. Se o A também mudou o estado, o A vence. Detalhe e diagrama em [`how-it-works.md`](how-it-works.md), seção 11.

## Fluxo B → A completo: proposta e aprovação (desenho, não implementado)

Escopo opcional do avaliador, fora da entrega (`out-of-scope.md`). O desenho responde às duas perguntas dele: anti-eco (ADR-009) e concorrência A × B (ADR-011). O A continua sendo a fonte da verdade: o B propõe, o A aprova (ADR-006).

```mermaid
sequenceDiagram
  autonumber
  participant OP as Operador B
  participant B as Sistema B
  participant AU as Auditor do sync
  participant DB as Postgres
  participant A as Sistema A
  participant T as Técnico

  OP->>B: muda o estado para RESOLVED
  AU->>B: varredura: GET /records/B-7
  AU->>AU: hash ≠ last_written_hash → a mudança é do B (anti-eco, ADR-009)
  AU->>DB: proposals (solve, based_on_hash) + audit_log
  AU->>A: Solução pendente + status 5 + solvedate (detecção UTC) + nota do sync-bot
  Note over A: status 5 congela o chamado: só aceita nota (409 nas edições)
  alt Técnico aprova
    T->>A: aprova
    A-->>AU: status 6 (Fechado)
    AU->>B: confirma CLOSED (uma escrita e para)
  else Técnico recusa (com motivo)
    T->>A: recusa
    A-->>AU: status 2 (Em atendimento)
    AU->>B: reverte para IN_PROGRESS + nota com o motivo nos dois lados
  end
  Note over AU,A: se o A mudou o mesmo campo antes da decisão,<br/>a proposta vira superseded (based_on_hash ≠ estado atual)
```

## Exclusão em 2 passos (desenho, não implementado)

Na entrega, um registro que some do B é procurado pelo marcador e, se não aparecer, **recriado** (S3.8): o A é a fonte da verdade. O fluxo abaixo, com decisão humana, é o desenho para quando o B → A existir.

Para o sync, "excluído no B" e "perdido pelo B" parecem iguais (404). Quem decide é uma pessoa (ADR-007).

```mermaid
sequenceDiagram
  autonumber
  participant OP as Operador B
  participant B as Sistema B
  participant AU as Auditor do sync
  participant DB as Postgres
  participant A as Sistema A
  participant T as Técnico

  OP->>B: DELETE /operator/records/B-7
  AU->>B: GET /records/B-7
  B-->>AU: 404
  AU->>DB: mapping = deletion_requested + proposals (delete)
  AU->>A: nota "Exclusão solicitada pelo B (autor/motivo não informado pelo B)"
  Note over DB: updates do A para o 42 ficam retidos na fila
  alt Técnico aprova
    T->>A: aprova
    AU->>A: fecha o chamado (status 6, nunca exclui)
    AU->>DB: mapping = archived
  else Técnico recusa
    T->>A: recusa
    AU->>B: procura ⟦s:glpi-42⟧ na listagem (não duplicar)
    AU->>B: POST novo registro → B-12
    AU->>DB: b_record_history += B-7, b_record_id = B-12
    AU->>B: entrega os updates retidos
  end
```

## Estados

Os estados `quarantine`, `deletion_requested` e `archived` existem no schema para o desenho do B → A, mas a entrega não os usa.

```mermaid
stateDiagram-v2
  direction LR
  state "ticket_mapping.state" as M {
    [*] --> create_uncertain: intenção gravada antes do POST
    create_uncertain --> active: create confirmado pela leitura
    create_uncertain --> active: marcador achado na varredura (adota)
    create_uncertain --> active: N varreduras sem achar (recria)
    active --> create_uncertain: registro sumiu do B e o marcador não está na listagem
  }
```

```mermaid
stateDiagram-v2
  direction LR
  state "sync_jobs.status" as J {
    [*] --> pending
    pending --> running: SKIP LOCKED + lease
    running --> done
    running --> pending: falha (backoff) ou lease vencido
    running --> dead: permanente 3× ou transitório por 24 h
    dead --> pending: reprocessar (relê o A)
  }
```

## Onde cada garantia mora

| Garantia | Mecanismos entregues | Cenários que provam |
|---|---|---|
| Nenhuma duplicata | Um job ativo por chamado · lock + lease no `claim` · marcador `⟦s:…⟧` · intenção `create_uncertain` antes do POST + varredura | A1, A2, A4, A6, B3 |
| Nenhuma perda | Webhook persistido antes do 200 · poller com sobreposição · retries até 24 h · disjuntor sem gastar tentativa · lease · verificação pós-escrita · DLQ que relê o A · `/ready` pausa o worker | B1, B2, B3, B5, B10, E4 |
| Antigo nunca sobre novo | Worker sempre relê o A · hash dos campos sincronizáveis + `date_mod` em UTC · um job por chamado · relógio do B ignorado | C1, B6, B10, B11 |
| Sem ping-pong (desenho) | `last_written_hash` já é gravado · escritas do `sync-bot` não disparariam sync · uma escrita por decisão | ADR-009 |

Testes por cenário: [`how-it-works.md`](how-it-works.md) seção 9 e [`tests/e2e/README.md`](../tests/e2e/README.md).
