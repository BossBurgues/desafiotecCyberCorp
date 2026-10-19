import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProcessJob } from '../../src/application/process-job.js';
import { findMarker } from '../../src/domain/index.js';
import { migrate } from '../../src/infra/db/migrate.js';
import { enqueue, reprocessDead } from '../../src/infra/queue/queue.js';
import { drain, runOnce, type JobProcessor } from '../../src/infra/queue/runner.js';
import { fakeA, fakeB, ticket } from '../fakes.js';
import { memoryLogger } from '../helpers.js';
import { TEST_DATABASE_URL, isolatedPool } from './db.js';

const LEASE = 60_000;

/** Cenários do catálogo (seção 12 do plano) que rodam como integração, com Postgres de verdade e A/B em memória. */
describe.skipIf(!TEST_DATABASE_URL)('cenários de integração do núcleo A→B', () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  const { logger } = memoryLogger('silent');
  let A: ReturnType<typeof fakeA>;
  let B: ReturnType<typeof fakeB>;
  let processJob: JobProcessor;

  beforeEach(async () => {
    ({ pool, drop } = await isolatedPool());
    await migrate(pool, logger);
    A = fakeA([ticket(1)]);
    B = fakeB();
    processJob = createProcessJob({
      pool,
      a: A.client,
      b: B.client,
      logger,
      timeZone: 'America/Sao_Paulo',
      markerField: 'description',
      uncertainScans: 2,
      listPageSize: 100,
    });
  });
  afterEach(async () => drop());

  const markersInB = (ticketId: number) => [...B.records.values()].filter((r) => findMarker(r.description) === ticketId).length;
  /** Faz todos os jobs pendentes vencerem agora (simula o backoff passando). */
  const due = () => pool.query(`UPDATE sync_jobs SET next_run_at = now() WHERE status = 'pending'`);

  it('A6: dois workers no mesmo chamado → só um processa (SKIP LOCKED + um job por chamado)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let runs = 0;
    // Processador lento: se dois workers pegassem o mesmo chamado, os dois estariam aqui ao mesmo tempo
    const slow: JobProcessor = async (job, signal) => {
      inFlight++;
      runs++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 150));
      try {
        await processJob(job, signal);
      } finally {
        inFlight--;
      }
    };
    // O mesmo chamado sinalizado várias vezes (webhook + poll + retry do A) enquanto dois workers drenam a fila
    await Promise.all([enqueue(pool, 1), enqueue(pool, 1), enqueue(pool, 1)]);
    const worker = () => runOnce({ pool, processor: slow, logger, leaseMs: LEASE });
    const results = await Promise.all([worker(), worker()]);

    expect(results.sort()).toEqual([false, true]); // um pegou o job, o outro achou a fila vazia
    expect(runs).toBe(1);
    expect(maxInFlight).toBe(1);
    expect(markersInB(1)).toBe(1);
  });

  it('A6: com dez chamados e quatro workers, cada chamado é processado exatamente uma vez', async () => {
    for (let id = 2; id <= 10; id++) A.put(ticket(id));
    const seen = new Map<number, number>();
    const counting: JobProcessor = async (job, signal) => {
      seen.set(job.ticket_id, (seen.get(job.ticket_id) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, 20));
      return processJob(job, signal);
    };
    for (let id = 1; id <= 10; id++) await Promise.all([enqueue(pool, id), enqueue(pool, id)]);
    await Promise.all(
      Array.from({ length: 4 }, () => drain({ pool, processor: counting, logger, leaseMs: LEASE, maxJobs: 10 })),
    );
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    expect(seen.size).toBe(10);
    expect(B.records.size).toBe(10);
  });

  it('B10: reprocessar da DLQ envia o estado atual do A, não o do momento do erro', async () => {
    // O B recusa o update três vezes (permanente) → DLQ
    await enqueue(pool, 1);
    await drain({ pool, processor: processJob, logger, leaseMs: LEASE, maxJobs: 1 });
    A.put(ticket(1, { name: 'Versão do erro' }));
    await enqueue(pool, 1);
    for (let i = 0; i < 3; i++) B.plan.update.push({ reason: 'rejected', status: 422 });
    for (let i = 0; i < 3; i++) {
      await due();
      await drain({ pool, processor: processJob, logger, leaseMs: LEASE, maxJobs: 1 });
    }
    const dead = (await pool.query(`SELECT id, last_error FROM sync_jobs WHERE status = 'dead'`)).rows;
    expect(dead).toHaveLength(1);
    expect([...B.records.values()][0]!.title).toBe('Chamado 1');

    // Enquanto estava na DLQ, o Técnico mudou o chamado de novo
    A.put(ticket(1, { name: 'Versão atual', priority: 5 }));
    const re = await reprocessDead(pool, Number(dead[0].id));
    expect(re).not.toBeNull();
    await drain({ pool, processor: processJob, logger, leaseMs: LEASE, maxJobs: 1 });

    expect(B.records.size).toBe(1);
    expect([...B.records.values()][0]).toMatchObject({ title: 'Versão atual', severity: 'CRITICAL' });
    expect((await pool.query(`SELECT status FROM sync_jobs WHERE id = $1`, [re!.jobId])).rows[0].status).toBe('done');
  });

  it('B5: no retry depois do ack sem gravar o B recebe o estado atual do A', async () => {
    await enqueue(pool, 1);
    await drain({ pool, processor: processJob, logger, leaseMs: LEASE, maxJobs: 1 });

    // O B responde 200 aos dois próximos updates sem gravar; nesse meio-tempo o Técnico muda o chamado de novo
    A.put(ticket(1, { name: 'Primeira edição', date_mod: '2026-10-18 10:10:00' }));
    await enqueue(pool, 1);
    B.ackWithoutPersist.update = 2;
    await drain({ pool, processor: processJob, logger, leaseMs: LEASE, maxJobs: 1 });
    A.put(ticket(1, { name: 'Edição atual', priority: 5, date_mod: '2026-10-18 10:20:00' }));
    for (let i = 0; i < 3; i++) {
      await due();
      await drain({ pool, processor: processJob, logger, leaseMs: LEASE, maxJobs: 1 });
    }

    expect(B.records.size).toBe(1);
    expect([...B.records.values()][0]).toMatchObject({ title: 'Edição atual', severity: 'CRITICAL' });
    expect(B.calls.update).toBe(3); // 2 acks sem gravar + 1 confirmado pela leitura
    expect((await pool.query(`SELECT status FROM sync_jobs ORDER BY id`)).rows.map((r) => r.status)).toEqual(['done', 'done']);
  });

  describe('G4: obrigatório vazio → DLQ permanente com o motivo + alerta', () => {
    const runThreeTimes = async () => {
      await enqueue(pool, 1);
      for (let i = 0; i < 3; i++) {
        await due();
        await drain({ pool, processor: processJob, logger, leaseMs: LEASE, maxJobs: 1 });
      }
      return (await pool.query(`SELECT status, attempts, error_class, last_error FROM sync_jobs`)).rows[0];
    };
    const alerts = async () => (await pool.query(`SELECT kind, ticket_id, message FROM alerts_outbox`)).rows;

    it('título vazio no A: o domínio recusa antes de chamar o B (permanente, 3 tentativas, sem escrita)', async () => {
      A.put(ticket(1, { name: '   ' }));
      const job = await runThreeTimes();
      expect(job).toMatchObject({ status: 'dead', attempts: 3, error_class: 'permanent' });
      expect(job.last_error).toMatch(/"name"/);
      expect(B.calls.create).toBe(0);
      expect(await alerts()).toEqual([expect.objectContaining({ kind: 'dlq', ticket_id: '1' })]);
    });

    it('B responde 422 a um obrigatório que o domínio não conhece: permanente → DLQ com o motivo do B', async () => {
      for (let i = 0; i < 3; i++) B.plan.create.push({ reason: 'rejected', status: 422 });
      const job = await runThreeTimes();
      expect(job).toMatchObject({ status: 'dead', attempts: 3, error_class: 'permanent' });
      expect(job.last_error).toMatch(/rejected/);
      expect(B.records.size).toBe(0);
      const [alert] = await alerts();
      expect(alert).toMatchObject({ kind: 'dlq', ticket_id: '1' });
      expect(alert.message).toMatch(/permanent/);
    });
  });
});
