-- B → A leve (ADR-014): o que o sync escreveu por último no B, campo a campo. Comparado com o registro atual do B,
-- diz o que o próprio B mudou (estado, título…) desde a nossa última escrita. O last_written_hash continua sendo o
-- teste rápido ("o B mudou alguma coisa?"); este registro responde "o quê"
ALTER TABLE ticket_mapping ADD COLUMN last_written_record jsonb;
