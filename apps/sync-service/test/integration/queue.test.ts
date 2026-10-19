import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BError } from '../../src/adapters/system-b/errors.js';
import { MappingError } from '../../src/domain/errors.js';
import { migrate } from '../../src/infra/db/migrate.js';
import { DEFAULT_RETRY_POLICY } from '../../src/infra/queue/backoff.js';
import { claim, complete, enqueue, extendLease, fail, reprocessDead, type Job } from '../../src/infra/queue/queue.js';
import { classifyFailure, drain, runOnce } from '../../src/infra/queue/runner.js';
import { memoryLogger } from '../helpers.js';
import { TEST_DATABASE_URL, isolatedPool } from './db.js';

const LEASE = 60_000;
const noJitter = () => 0;

describe.skipIf(!TEST_DATABASE_URL)('fila no Postgres (S3.3, ADR-002, ADR-008)', () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  const { logger } = memoryLogger('silent');

  beforeEach(async () => {
    ({ pool, drop } = await isolatedPool());
    await migrate(pool, logger);
  });
  afterEach(async () => drop());

  const row = async (id: number) => (await pool.query('SELECT * FROM sync_jobs WHERE id = $1', [id])).rows[0];
  /** Faz o job vencer agora (simula a passagem do backoff). */
  const due = (id: number) => pool.query(`UPDATE sync_jobs SET next_run_at = now() - interval '1 second' WHERE id = $1`, [id]);
  const claimOne = async () => {
    const [job] = await claim(pool, { leaseMs: LEASE });
    expect(job).toBeDefined();
    return job!;
  };

  describe('um job por chamado', () => {
    it('eventos repetidos do mesmo chamado aglutinam num job só', async () => {
      const a = await enqueue(pool, 42);
      const b = await enqueue(pool, 42);
      const c = await enqueue(pool, 7);
      expect(a.coalesced).toBe(false);
      expect(b).toEqual({ id: a.id, coalesced: true });
      expect(c.id).not.toBe(a.id);
      expect((await pool.query('SELECT count(*)::int AS n FROM sync_jobs')).rows[0].n).toBe(2);
    });

    it('100 enqueues concorrentes do mesmo chamado → 1 job', async () => {
      await Promise.all(Array.from({ length: 100 }, () => enqueue(pool, 42)));
      expect((await pool.query('SELECT count(*)::int AS n FROM sync_jobs WHERE ticket_id = 42')).rows[0].n).toBe(1);
    });

    it('evento durante o processamento marca rerun: o job volta para a fila em vez de virar done', async () => {
      await enqueue(pool, 42);
      const job = await claimOne();
      await enqueue(pool, 42); // o A mudou depois de o worker ler
      expect(await complete(pool, job)).toBe('requeued');
      expect(await row(job.id)).toMatchObject({ status: 'pending', rerun: false });
      const again = await claimOne();
      expect(again.id).toBe(job.id);
      expect(await complete(pool, again)).toBe('done');
    });
  });

  describe('SKIP LOCKED e lease', () => {
    it('workers concorrentes nunca pegam o mesmo job', async () => {
      for (let t = 1; t <= 20; t++) await enqueue(pool, t);
      const batches = await Promise.all(Array.from({ length: 8 }, () => claim(pool, { leaseMs: LEASE, limit: 5 })));
      const ids = batches.flat().map((j) => j.id);
      expect(ids).toHaveLength(20);
      expect(new Set(ids).size).toBe(20);
    });

    it('job em backoff não é pego antes da hora', async () => {
      const { id } = await enqueue(pool, 1);
      await pool.query(`UPDATE sync_jobs SET next_run_at = now() + interval '1 hour' WHERE id = $1`, [id]);
      expect(await claim(pool, { leaseMs: LEASE })).toEqual([]);
    });

    it('lease vencido (worker caiu) é retomado e conta como tentativa transitória', async () => {
      await enqueue(pool, 1);
      const first = await claimOne();
      expect(await claim(pool, { leaseMs: LEASE })).toEqual([]); // lease válido: ninguém pega
      await pool.query(`UPDATE sync_jobs SET locked_until = now() - interval '1 second' WHERE id = $1`, [first.id]);

      const second = await claimOne();
      expect(second.id).toBe(first.id);
      expect(second.lease_token).not.toBe(first.lease_token);
      expect(await row(second.id)).toMatchObject({ attempts: 1, error_class: 'transient' });

      // o worker antigo, se acordar, não sobrescreve nada
      expect(await complete(pool, first)).toBe('lost_lease');
      expect(await extendLease(pool, first, LEASE)).toBe(false);
      expect(await fail(pool, first, { errorClass: 'transient', message: 'x' })).toEqual({ status: 'lost_lease' });
      expect(await extendLease(pool, second, LEASE)).toBe(true);
      expect(await complete(pool, second)).toBe('done');
    });

    it('depois de done, um evento novo cria outro job', async () => {
      await enqueue(pool, 1);
      await complete(pool, await claimOne());
      expect((await enqueue(pool, 1)).coalesced).toBe(false);
    });
  });

  describe('backoff e DLQ', () => {
    it('transitório: reagenda com backoff crescente e zera tudo no sucesso', async () => {
      const { id } = await enqueue(pool, 1);
      const delays: number[] = [];
      for (let i = 0; i < 3; i++) {
        await due(id);
        const out = await fail(pool, await claimOne(), { errorClass: 'transient', message: 'B 503' }, DEFAULT_RETRY_POLICY, noJitter);
        expect(out.status).toBe('pending');
        delays.push((out as { delayMs: number }).delayMs);
      }
      expect(delays).toEqual([1_000, 2_000, 4_000]);
      const r = await row(id);
      expect(r).toMatchObject({ status: 'pending', attempts: 3, error_class: 'transient', last_error: 'B 503' });
      expect(r.next_run_at.getTime()).toBeGreaterThan(Date.now() + 3_000);

      await due(id);
      await complete(pool, await claimOne());
      expect(await row(id)).toMatchObject({ status: 'done', attempts: 0, error_class: null, first_failed_at: null });
    });

    it('transitório vai para a DLQ só depois de 24 h desde a primeira falha', async () => {
      const { id } = await enqueue(pool, 1);
      await fail(pool, await claimOne(), { errorClass: 'transient', message: 'B fora' });
      await pool.query(`UPDATE sync_jobs SET first_failed_at = now() - interval '23 hours', attempts = 50 WHERE id = $1`, [id]);
      await due(id);
      expect((await fail(pool, await claimOne(), { errorClass: 'transient', message: 'B fora' })).status).toBe('pending');

      await pool.query(`UPDATE sync_jobs SET first_failed_at = now() - interval '24 hours 1 second' WHERE id = $1`, [id]);
      await due(id);
      expect(await fail(pool, await claimOne(), { errorClass: 'transient', message: 'B fora' })).toEqual({ status: 'dead' });
    });

    it('permanente: 3 tentativas → DLQ + alerta', async () => {
      const { id } = await enqueue(pool, 9);
      for (const expected of ['pending', 'pending', 'dead']) {
        await due(id);
        const out = await fail(pool, await claimOne(), { errorClass: 'permanent', message: '422 title vazio' });
        expect(out.status).toBe(expected);
      }
      expect(await row(id)).toMatchObject({ status: 'dead', attempts: 3, error_class: 'permanent' });
      const alerts = (await pool.query('SELECT kind, ticket_id, message FROM alerts_outbox')).rows;
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ kind: 'dlq', ticket_id: '9' });
      expect(alerts[0].message).toContain('422 title vazio');
    });

    it('disjuntor aberto espera o tempo pedido sem gastar tentativa', async () => {
      const { id } = await enqueue(pool, 1);
      const out = await fail(
        pool,
        await claimOne(),
        { errorClass: 'transient', message: 'disjuntor aberto', retryAfterMs: 30_000, countsAttempt: false },
        DEFAULT_RETRY_POLICY,
        noJitter,
      );
      expect(out).toEqual({ status: 'pending', delayMs: 30_000 });
      expect((await row(id)).attempts).toBe(0);
    });

    it('Retry-After maior que o backoff vence', async () => {
      await enqueue(pool, 1);
      const out = await fail(pool, await claimOne(), { errorClass: 'transient', message: '429', retryAfterMs: 7_000 }, DEFAULT_RETRY_POLICY, noJitter);
      expect(out).toEqual({ status: 'pending', delayMs: 7_000 });
    });

    it('job que morre com evento novo pendente deixa um job novo para a mudança nova', async () => {
      const { id } = await enqueue(pool, 5);
      await pool.query('UPDATE sync_jobs SET attempts = 2 WHERE id = $1', [id]);
      const job = await claimOne();
      await enqueue(pool, 5);
      expect((await fail(pool, job, { errorClass: 'permanent', message: '422' })).status).toBe('dead');
      const active = (await pool.query(`SELECT id, attempts FROM sync_jobs WHERE ticket_id = 5 AND status = 'pending'`)).rows;
      expect(active).toHaveLength(1);
      expect(active[0].attempts).toBe(0);
    });
  });

  describe('reprocessar da DLQ', () => {
    it('cria um job novo que relê o A; o item morto fica como histórico', async () => {
      // "A" de mentira: o processador sempre lê o estado atual, nunca um payload guardado no job
      const a = new Map([[3, 'versão 1']]);
      const delivered: string[] = [];
      let bUp = false;
      const processor = async (job: Job) => {
        if (!bUp) throw new BError('rejected', '422 do B');
        delivered.push(a.get(job.ticket_id)!);
      };
      const opts = { pool, processor, logger, leaseMs: LEASE, policy: { ...DEFAULT_RETRY_POLICY, permanentMaxAttempts: 1 } };

      const { id: deadId } = await enqueue(pool, 3);
      expect(await runOnce(opts)).toBe(true);
      expect((await row(deadId)).status).toBe('dead');

      a.set(3, 'versão 2'); // o A mudou enquanto o job estava na DLQ
      bUp = true;
      const re = await reprocessDead(pool, deadId);
      expect(re).not.toBeNull();
      expect(re!.jobId).not.toBe(deadId);
      expect(await reprocessDead(pool, deadId)).toBeNull(); // reprocessar duas vezes não duplica

      expect(await drain({ ...opts, maxJobs: 10 })).toBe(1);
      expect(delivered).toEqual(['versão 2']);
      expect((await row(deadId)).reprocessed_at).not.toBeNull();
    });
  });

  describe('runner', () => {
    it('classifica o erro: disjuntor não gasta tentativa, mapping é permanente, desconhecido é transitório', () => {
      expect(classifyFailure(new BError('circuit_open', 'x', { retryAfterMs: 10 }))).toMatchObject({
        errorClass: 'transient',
        countsAttempt: false,
        retryAfterMs: 10,
      });
      expect(classifyFailure(new BError('schema_drift', 'x'))).toMatchObject({ errorClass: 'permanent', countsAttempt: true });
      expect(classifyFailure(new MappingError('status', 9, 'fora da tabela'))).toMatchObject({ errorClass: 'permanent' });
      expect(classifyFailure(new Error('ECONNRESET'))).toMatchObject({ errorClass: 'transient' });
      expect(classifyFailure('estranho')).toMatchObject({ errorClass: 'transient', message: 'estranho' });
    });

    it('renova o lease enquanto um job longo roda', async () => {
      const { id } = await enqueue(pool, 1);
      let before = 0;
      let after = 0;
      await runOnce({
        pool,
        logger,
        leaseMs: 1_200,
        processor: async () => {
          before = (await row(id)).locked_until.getTime();
          await new Promise((r) => setTimeout(r, 700));
          after = (await row(id)).locked_until.getTime();
        },
      });
      expect(after).toBeGreaterThan(before);
      expect((await row(id)).status).toBe('done');
    });

    it('fila vazia: runOnce devolve false', async () => {
      expect(await runOnce({ pool, logger, leaseMs: LEASE, processor: async () => {} })).toBe(false);
    });
  });
});
