-- Fila (S3.3, ADR-002 e ADR-008): o que faltava no sync_jobs para lease seguro, eventos durante o processamento e DLQ.

-- Dono do lease. Concluir ou falhar exige o mesmo token: um worker lento cujo lease venceu (e outro pegou o job)
-- não sobrescreve o resultado do novo dono
ALTER TABLE sync_jobs ADD COLUMN lease_token uuid;

-- Evento que chegou enquanto o job rodava. O worker pode ter lido o A antes da mudança, então o job volta para
-- pending em vez de virar done: a mudança nova nunca se perde na aglutinação
ALTER TABLE sync_jobs ADD COLUMN rerun boolean NOT NULL DEFAULT false;

-- Item da DLQ já reprocessado (fica como histórico; o reprocessamento é um job novo que relê o A)
ALTER TABLE sync_jobs ADD COLUMN reprocessed_at timestamptz;

CREATE INDEX sync_jobs_dead_idx ON sync_jobs (updated_at) WHERE status = 'dead' AND reprocessed_at IS NULL;
