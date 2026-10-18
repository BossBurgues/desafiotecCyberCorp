-- processJob (S3.6, ADR-004) e entrada (S3.4).

-- create_uncertain: quantas varreduras da listagem do B já rodaram sem achar o marcador. Só depois de
-- CREATE_UNCERTAIN_SCANS varreduras o create é reenviado; antes disso, reenviar seria apostar numa duplicata
ALTER TABLE ticket_mapping ADD COLUMN uncertain_scans integer NOT NULL DEFAULT 0 CHECK (uncertain_scans >= 0);
ALTER TABLE ticket_mapping ADD COLUMN uncertain_since timestamptz;

-- Webhook: o event_id do A identifica a entrega. O mesmo evento repetido (retry do A, replay dentro da janela)
-- é gravado uma vez só
ALTER TABLE inbound_events ADD COLUMN event_id text;
CREATE UNIQUE INDEX inbound_events_event_id_uq ON inbound_events (event_id) WHERE event_id IS NOT NULL;
