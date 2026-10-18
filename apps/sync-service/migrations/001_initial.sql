-- Esquema inicial do sync (seção 8 do plano). Tudo em UTC (timestamptz).

-- Todo sinal recebido (webhook, poll do A, varredura do B) é gravado antes de qualquer resposta: nada se perde na entrada
CREATE TABLE inbound_events (
  id          bigserial PRIMARY KEY,
  source      text        NOT NULL CHECK (source IN ('webhook', 'poll', 'scan')),
  ticket_id   bigint      NOT NULL,
  payload     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inbound_events_ticket_idx ON inbound_events (ticket_id, received_at);

-- Fila no Postgres (ADR-002)
CREATE TABLE sync_jobs (
  id              bigserial PRIMARY KEY,
  ticket_id       bigint      NOT NULL,
  kind            text        NOT NULL,
  status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'dead')),
  attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_run_at     timestamptz NOT NULL DEFAULT now(),
  locked_until    timestamptz,
  error_class     text        CHECK (error_class IN ('transient', 'permanent')),
  last_error      text,
  first_failed_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- Um job ativo por chamado: eventos repetidos aglutinam e dois workers nunca enviam o mesmo chamado ao mesmo tempo
CREATE UNIQUE INDEX sync_jobs_one_active_per_ticket ON sync_jobs (ticket_id) WHERE status IN ('pending', 'running');
CREATE INDEX sync_jobs_due_idx ON sync_jobs (next_run_at) WHERE status = 'pending';
CREATE INDEX sync_jobs_lease_idx ON sync_jobs (locked_until) WHERE status = 'running';

-- Chamado do A ↔ registro do B. b_record_id fica nulo em create_uncertain (ainda não sabemos o ID)
CREATE TABLE ticket_mapping (
  a_ticket_id              bigint PRIMARY KEY,
  b_record_id              text UNIQUE,
  b_record_history         text[]      NOT NULL DEFAULT '{}',
  state                    text        NOT NULL DEFAULT 'active'
                           CHECK (state IN ('active', 'create_uncertain', 'quarantine', 'deletion_requested', 'archived')),
  last_synced_hash         text,
  last_written_hash        text,
  last_synced_date_mod_utc timestamptz,
  last_verified_at         timestamptz,
  missing_since            timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Propostas do B que esperam decisão do A (ADR-006)
CREATE TABLE proposals (
  id             bigserial PRIMARY KEY,
  a_ticket_id    bigint      NOT NULL REFERENCES ticket_mapping (a_ticket_id),
  kind           text        NOT NULL CHECK (kind IN ('solve', 'delete', 'reopen')),
  field          text,
  proposed_value jsonb,
  based_on_hash  text        NOT NULL,
  status         text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  decided_by     text,
  decided_at     timestamptz,
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proposals_ticket_status_idx ON proposals (a_ticket_id, status);

-- Notas e comentários sincronizados; o marcador (⟦n:…⟧ / ⟦from-b:…⟧) é a chave de idempotência
CREATE TABLE note_mapping (
  id            bigserial PRIMARY KEY,
  a_followup_id bigint,
  b_comment_id  text,
  direction     text        NOT NULL CHECK (direction IN ('a_to_b', 'b_to_a')),
  marker        text        NOT NULL UNIQUE,
  state         text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Trilha técnica. A proteção append-only (sem UPDATE/DELETE), o mascaramento e a retenção entram na S5.1
CREATE TABLE audit_log (
  id               bigserial PRIMARY KEY,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  ticket_id        bigint,
  direction        text,
  action           text        NOT NULL,
  actor            text        NOT NULL,
  correlation_id   text,
  request_summary  jsonb,
  response_summary jsonb,
  latency_ms       integer,
  outcome          text        NOT NULL,
  origin_ip        inet
);
CREATE INDEX audit_log_ticket_idx ON audit_log (ticket_id, occurred_at);
CREATE INDEX audit_log_occurred_idx ON audit_log (occurred_at);

-- Até onde o poller do A já leu (date_mod em UTC)
CREATE TABLE poll_checkpoint (
  source            text PRIMARY KEY,
  last_date_mod_utc timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Mock de e-mail: alertas (DLQ, quarentena, exclusão pedida) ficam aqui em vez de sair por SMTP
CREATE TABLE alerts_outbox (
  id         bigserial PRIMARY KEY,
  kind       text        NOT NULL,
  ticket_id  bigint,
  message    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
