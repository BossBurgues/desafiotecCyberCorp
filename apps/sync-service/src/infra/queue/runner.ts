import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { BError } from '../../adapters/system-b/errors.js';
import { MappingError } from '../../domain/errors.js';
import type { RetryPolicy } from './backoff.js';
import { claim, complete, extendLease, fail, type FailureInfo, type Job } from './queue.js';

/** Processa um job. Recebe o sinal de lease perdido: se disparar, outro worker é o dono e este deve parar. */
export type JobProcessor = (job: Job, signal: AbortSignal) => Promise<void>;

/** Transitório × permanente (ADR-008). Erro desconhecido é transitório: na dúvida, tentar de novo não perde nada. */
export function classifyFailure(err: unknown): FailureInfo {
  if (err instanceof BError) {
    return {
      errorClass: err.errorClass,
      message: err.message,
      retryAfterMs: err.retryAfterMs,
      countsAttempt: err.reason !== 'circuit_open',
    };
  }
  if (err instanceof MappingError) return { errorClass: 'permanent', message: err.message };
  return { errorClass: 'transient', message: err instanceof Error ? err.message : String(err) };
}

export interface RunnerOptions {
  pool: Pool;
  processor: JobProcessor;
  logger: Logger;
  leaseMs: number;
  policy?: RetryPolicy;
}

/** Pega um job e processa. false = fila vazia (nada vencido). */
export async function runOnce(options: RunnerOptions): Promise<boolean> {
  const { pool, processor, logger, leaseMs, policy } = options;
  const [job] = await claim(pool, { leaseMs });
  if (!job) return false;
  const log = logger.child({ job_id: job.id, ticket_id: job.ticket_id, attempts: job.attempts });

  // Renova o lease a cada terço do prazo enquanto o processamento durar
  const lost = new AbortController();
  const heartbeat = setInterval(() => {
    extendLease(pool, job, leaseMs)
      .then((ok) => {
        if (!ok) lost.abort(new Error('lease perdido'));
      })
      .catch((err: unknown) => log.warn({ err }, 'falha ao renovar o lease'));
  }, Math.max(50, Math.floor(leaseMs / 3)));

  try {
    await processor(job, lost.signal);
    const outcome = await complete(pool, job);
    if (outcome === 'lost_lease') log.warn('job concluído, mas o lease já era de outro worker');
    else log.info({ outcome }, outcome === 'done' ? 'job concluído' : 'job concluído; mudança nova chegou no meio, volta para a fila');
  } catch (err) {
    const failure = classifyFailure(err);
    const outcome = await fail(pool, job, failure, policy);
    if (outcome.status === 'dead') log.error({ failure }, 'job foi para a DLQ');
    else if (outcome.status === 'pending') log.warn({ failure, delay_ms: outcome.delayMs }, 'job falhou; nova tentativa agendada');
    else log.warn({ failure }, 'job falhou, mas o lease já era de outro worker');
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

/** Tick do worker: processa até `maxJobs` jobs vencidos, um por vez. */
export async function drain(options: RunnerOptions & { maxJobs: number }): Promise<number> {
  let n = 0;
  while (n < options.maxJobs && (await runOnce(options))) n++;
  return n;
}
