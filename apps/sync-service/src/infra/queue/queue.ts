import type { Pool, PoolClient } from 'pg';
import { backoffDelayMs, DEFAULT_RETRY_POLICY, type RetryPolicy } from './backoff.js';

/** Pool ou cliente dentro de uma transação: o enqueue pode rodar na mesma transação que grava o evento (ADR-002). */
type Db = Pick<Pool | PoolClient, 'query'>;

export interface Job {
  id: number;
  ticket_id: number;
  kind: string;
  attempts: number;
  lease_token: string;
  first_failed_at: Date | null;
}

export interface FailureInfo {
  errorClass: 'transient' | 'permanent';
  message: string;
  /** Espera mínima pedida (Retry-After do 429, tempo restante do disjuntor). */
  retryAfterMs?: number | undefined;
  /** false quando a requisição nem saiu (disjuntor aberto): esperar não gasta tentativa (ADR-008). */
  countsAttempt?: boolean;
}

export type FailOutcome = { status: 'pending'; delayMs: number } | { status: 'dead' } | { status: 'lost_lease' };

export const DEFAULT_JOB_KIND = 'sync_ticket';

/**
 * Enfileira o chamado. Já existe job ativo → aglutina (o worker sempre lê o estado atual do A, então um job basta).
 * Se o job ativo está rodando, marca `rerun`: o worker pode ter lido o A antes desta mudança.
 */
export async function enqueue(db: Db, ticketId: number, kind = DEFAULT_JOB_KIND): Promise<{ id: number; coalesced: boolean }> {
  const { rows } = await db.query<{ id: string; coalesced: boolean }>(
    `INSERT INTO sync_jobs (ticket_id, kind) VALUES ($1, $2)
     ON CONFLICT (ticket_id) WHERE status IN ('pending', 'running')
     DO UPDATE SET rerun = sync_jobs.rerun OR sync_jobs.status = 'running', updated_at = now()
     RETURNING id, (xmax <> 0) AS coalesced`,
    [ticketId, kind],
  );
  return { id: Number(rows[0]!.id), coalesced: rows[0]!.coalesced };
}

/**
 * Pega até `limit` jobs vencidos com FOR UPDATE SKIP LOCKED: dois workers nunca pegam o mesmo job e nenhum espera o
 * outro. Lease vencido (worker caiu no meio) também é retomado, e conta como uma tentativa transitória: um job que
 * derruba o worker toda vez acaba na DLQ em vez de girar para sempre.
 */
export async function claim(db: Db, options: { leaseMs: number; limit?: number }): Promise<Job[]> {
  const { rows } = await db.query<Job & { id: string; ticket_id: string }>(
    `WITH next AS (
       SELECT id, status FROM sync_jobs
       WHERE (status = 'pending' AND next_run_at <= now())
          OR (status = 'running' AND locked_until < now())
       ORDER BY next_run_at, id
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     UPDATE sync_jobs j SET
       status = 'running',
       lease_token = gen_random_uuid(),
       locked_until = now() + $1 * interval '1 millisecond',
       attempts = j.attempts + CASE WHEN next.status = 'running' THEN 1 ELSE 0 END,
       error_class = CASE WHEN next.status = 'running' THEN 'transient' ELSE j.error_class END,
       last_error = CASE WHEN next.status = 'running' THEN 'lease vencido: o worker parou no meio' ELSE j.last_error END,
       first_failed_at = CASE WHEN next.status = 'running' THEN COALESCE(j.first_failed_at, now()) ELSE j.first_failed_at END,
       updated_at = now()
     FROM next WHERE j.id = next.id
     RETURNING j.id, j.ticket_id, j.kind, j.attempts, j.lease_token, j.first_failed_at`,
    [options.leaseMs, options.limit ?? 1],
  );
  return rows.map((r) => ({ ...r, id: Number(r.id), ticket_id: Number(r.ticket_id) }));
}

/** Renova o lease de um job longo. false = o lease foi perdido (outro worker já o pegou): pare de processar. */
export async function extendLease(db: Db, job: Job, leaseMs: number): Promise<boolean> {
  const res = await db.query(
    `UPDATE sync_jobs SET locked_until = now() + $3 * interval '1 millisecond', updated_at = now()
     WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
    [job.id, job.lease_token, leaseMs],
  );
  return res.rowCount === 1;
}

/** Sucesso. Com `rerun` (chegou evento durante o processamento) o job volta para a fila já vencido. */
export async function complete(db: Db, job: Job): Promise<'done' | 'requeued' | 'lost_lease'> {
  const { rows } = await db.query<{ status: string }>(
    `UPDATE sync_jobs SET
       status = CASE WHEN rerun THEN 'pending' ELSE 'done' END,
       rerun = false, attempts = 0, next_run_at = now(), locked_until = NULL, lease_token = NULL,
       error_class = NULL, last_error = NULL, first_failed_at = NULL, updated_at = now()
     WHERE id = $1 AND lease_token = $2 AND status = 'running'
     RETURNING status`,
    [job.id, job.lease_token],
  );
  if (!rows[0]) return 'lost_lease';
  return rows[0].status === 'done' ? 'done' : 'requeued';
}

/**
 * Falha. Transitório: backoff até 24 h desde a primeira falha. Permanente: 3 tentativas. Depois disso, DLQ (`dead`)
 * com alerta. Se chegou evento durante o processamento (`rerun`) e o job morreu, a mudança nova ganha um job novo.
 */
export async function fail(
  pool: Pool,
  job: Job,
  failure: FailureInfo,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random = Math.random,
): Promise<FailOutcome> {
  const counts = failure.countsAttempt ?? true;
  const attempts = job.attempts + (counts ? 1 : 0);
  const delayMs = Math.max(
    counts ? backoffDelayMs(attempts, policy, random) : Math.round(random() * policy.baseMs),
    failure.retryAfterMs ?? 0,
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ status: 'pending' | 'dead'; rerun: boolean }>(
      `WITH old AS (SELECT id, rerun FROM sync_jobs WHERE id = $1 AND lease_token = $2 AND status = 'running' FOR UPDATE)
       UPDATE sync_jobs j SET
         attempts = $3::int,
         error_class = $4::text,
         last_error = $5::text,
         first_failed_at = COALESCE(j.first_failed_at, now()),
         status = CASE
           WHEN $4::text = 'permanent' AND $3::int >= $6::int THEN 'dead'
           WHEN $4::text = 'transient' AND now() - COALESCE(j.first_failed_at, now()) >= $7::bigint * interval '1 millisecond' THEN 'dead'
           ELSE 'pending' END,
         next_run_at = now() + $8::bigint * interval '1 millisecond',
         locked_until = NULL, lease_token = NULL, rerun = false, updated_at = now()
       FROM old WHERE j.id = old.id
       RETURNING j.status, old.rerun`,
      [
        job.id,
        job.lease_token,
        attempts,
        failure.errorClass,
        failure.message.slice(0, 2_000),
        policy.permanentMaxAttempts,
        policy.transientMaxAgeMs,
        delayMs,
      ],
    );
    const row = rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { status: 'lost_lease' };
    }
    if (row.status === 'dead') {
      await client.query(`INSERT INTO alerts_outbox (kind, ticket_id, message) VALUES ('dlq', $1, $2)`, [
        job.ticket_id,
        `Chamado ${job.ticket_id} foi para a DLQ depois de ${attempts} tentativa(s) (${failure.errorClass}): ${failure.message.slice(0, 500)}`,
      ]);
      if (row.rerun) await enqueue(client, job.ticket_id, job.kind);
    }
    await client.query('COMMIT');
    return row.status === 'dead' ? { status: 'dead' } : { status: 'pending', delayMs };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reprocessa um item da DLQ. O job não guarda payload: o reprocessamento é um job novo para o chamado, e o worker
 * relê o estado atual do A (ADR-008). O item morto fica como histórico, marcado com reprocessed_at.
 */
export async function reprocessDead(pool: Pool, deadJobId: number): Promise<{ jobId: number } | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ ticket_id: string; kind: string }>(
      `UPDATE sync_jobs SET reprocessed_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'dead' AND reprocessed_at IS NULL
       RETURNING ticket_id, kind`,
      [deadJobId],
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const { id } = await enqueue(client, Number(rows[0].ticket_id), rows[0].kind);
    await client.query('COMMIT');
    return { jobId: id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
