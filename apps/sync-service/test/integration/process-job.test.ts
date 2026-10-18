import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreateUncertainError, createProcessJob, getMapping } from '../../src/application/process-job.js';
import { findMarker } from '../../src/domain/index.js';
import { migrate } from '../../src/infra/db/migrate.js';
import { claim, enqueue, type Job } from '../../src/infra/queue/queue.js';
import { drain, type JobProcessor } from '../../src/infra/queue/runner.js';
import { fakeA, fakeB, ticket } from '../fakes.js';
import { memoryLogger } from '../helpers.js';
import { TEST_DATABASE_URL, isolatedPool } from './db.js';

const LEASE = 60_000;
const TZ = 'America/Sao_Paulo';

describe.skipIf(!TEST_DATABASE_URL)('processJob: create/update idempotente com marcador (S3.6, ADR-004)', () => {
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
      timeZone: TZ,
      markerField: 'description',
      uncertainScans: 2,
      listPageSize: 100,
    });
  });
  afterEach(async () => drop());

  const run = async (ticketId = 1) => {
    await enqueue(pool, ticketId);
    const [job] = await claim(pool, { leaseMs: LEASE });
    return processJob(job!, new AbortController().signal);
  };
  const markersInB = (ticketId: number) =>
    [...B.records.values()].filter((r) => findMarker(r.description) === ticketId).length;
  const audit = async (ticketId: number) =>
    (await pool.query('SELECT action, outcome FROM audit_log WHERE ticket_id = $1 ORDER BY id', [ticketId])).rows;

  it('chamado novo é criado no B com o marcador ⟦s:glpi-id⟧ e o mapeamento fica active com os hashes', async () => {
    await run();
    expect(B.records.size).toBe(1);
    const rec = [...B.records.values()][0]!;
    expect(rec.description.endsWith('⟦s:glpi-1⟧')).toBe(true);
    expect(rec.sourceUpdatedAt).toBe('2026-10-18T13:00:00Z');
    const m = await getMapping(pool, 1);
    expect(m).toMatchObject({ b_record_id: rec.id, state: 'active' });
    expect(m!.last_synced_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(m!.last_written_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await audit(1)).toEqual([{ action: 'create', outcome: 'ok' }]);
  });

  it('hash igual ao último sincronizado não escreve no B (no-op idempotente)', async () => {
    await run();
    await pool.query(`UPDATE sync_jobs SET status = 'done'`);
    // date_mod muda (ex.: nota do sync), dado sincronizável não: o hash ignora date_mod
    A.put(ticket(1, { date_mod: '2026-10-18 10:05:00' }));
    await run();
    expect(B.calls).toMatchObject({ create: 1, update: 0 });
    expect((await audit(1)).map((r) => r.action)).toEqual(['create', 'noop']);
  });

  it('chamado alterado no A atualiza o mesmo registro do B, sem criar outro', async () => {
    await run();
    await pool.query(`UPDATE sync_jobs SET status = 'done'`);
    A.put(ticket(1, { name: 'Título novo', priority: 5, date_mod: '2026-10-18 10:10:00' }));
    await run();
    expect(B.records.size).toBe(1);
    expect([...B.records.values()][0]).toMatchObject({ title: 'Título novo', severity: 'CRITICAL' });
  });

  it('lê o estado atual do A no momento do processamento, não o do evento', async () => {
    await enqueue(pool, 1);
    A.put(ticket(1, { name: 'Mudou depois do evento' }));
    const [job] = await claim(pool, { leaseMs: LEASE });
    await processJob(job!, new AbortController().signal);
    expect([...B.records.values()][0]!.title).toBe('Mudou depois do evento');
  });

  describe('create ambíguo nunca vira duplicata', () => {
    it('B grava e responde 500 (commit-then-fail): o próximo ciclo acha o marcador e adota, sem recriar', async () => {
      B.plan.create.push({ reason: 'server_error', status: 500, persist: true });
      await expect(run()).rejects.toMatchObject({ reason: 'server_error', ambiguous: true });
      expect(await getMapping(pool, 1)).toMatchObject({ state: 'create_uncertain', b_record_id: null });

      await processJob(await reclaim(), new AbortController().signal);

      expect(B.calls.create).toBe(1);
      expect(markersInB(1)).toBe(1);
      expect(await getMapping(pool, 1)).toMatchObject({ state: 'active', b_record_id: 'B-1' });
      expect((await audit(1)).map((r) => `${r.action}:${r.outcome}`)).toEqual([
        'create:ambiguous',
        'adopt:found_by_marker',
        'update:ok',
      ]);
    });

    it('timeout sem gravação: só recria depois de N varreduras sem achar o marcador', async () => {
      B.plan.create.push({ reason: 'timeout' });
      await expect(run()).rejects.toMatchObject({ reason: 'timeout' });

      // 1ª varredura: não achou, ainda não recria
      await expect(processJob(await reclaim(), new AbortController().signal)).rejects.toBeInstanceOf(CreateUncertainError);
      expect(B.calls.create).toBe(1);
      expect(await getMapping(pool, 1)).toMatchObject({ state: 'create_uncertain', uncertain_scans: 1 });

      // 2ª varredura: N = 2 atingido → recria
      await processJob(await reclaim(), new AbortController().signal);
      expect(B.calls.create).toBe(2);
      expect(markersInB(1)).toBe(1);
      expect(await getMapping(pool, 1)).toMatchObject({ state: 'active', uncertain_scans: 0 });
    });

    it('listagem atrasada (A7): o registro aparece na 2ª varredura e é adotado, nunca recriado', async () => {
      B.plan.create.push({ reason: 'timeout', persist: true });
      await expect(run()).rejects.toMatchObject({ reason: 'timeout' });
      B.hideFromList(1);
      await expect(processJob(await reclaim(), new AbortController().signal)).rejects.toBeInstanceOf(CreateUncertainError);
      await processJob(await reclaim(), new AbortController().signal);
      expect(B.calls.create).toBe(1);
      expect(markersInB(1)).toBe(1);
    });

    it('falha não ambígua (429, disjuntor aberto) não marca create_uncertain: o B não gravou', async () => {
      B.plan.create.push({ reason: 'rate_limited', status: 429 });
      await expect(run()).rejects.toMatchObject({ reason: 'rate_limited', ambiguous: false });
      expect(await getMapping(pool, 1)).toBeNull();
    });
  });

  it('lease perdido antes de escrever: não chama o B', async () => {
    await enqueue(pool, 1);
    const [job] = await claim(pool, { leaseMs: LEASE });
    const lost = new AbortController();
    lost.abort(new Error('lease perdido'));
    await expect(processJob(job!, lost.signal)).rejects.toThrow('lease perdido');
    expect(B.calls.create).toBe(0);
  });

  it('mapeamento em quarentena retém a entrega (sem escrever no B)', async () => {
    await pool.query(`INSERT INTO ticket_mapping (a_ticket_id, state) VALUES (1, 'quarantine')`);
    await run();
    expect(B.calls).toMatchObject({ create: 0, update: 0 });
    expect(await audit(1)).toEqual([{ action: 'skip', outcome: 'held_quarantine' }]);
  });

  it('chamado que não existe no A é ignorado com registro na auditoria', async () => {
    await run(99);
    expect(B.calls.create).toBe(0);
    expect(await audit(99)).toEqual([{ action: 'skip', outcome: 'missing_in_a' }]);
  });

  it('pelo runner: create ambíguo com retry termina com um registro só no B', async () => {
    B.plan.create.push({ reason: 'error_body', persist: true });
    await enqueue(pool, 1);
    for (let i = 0; i < 4; i++) {
      await drain({ pool, processor: processJob, logger, leaseMs: LEASE, maxJobs: 5 });
      await pool.query(`UPDATE sync_jobs SET next_run_at = now() WHERE status = 'pending'`);
    }
    expect(markersInB(1)).toBe(1);
    expect((await pool.query(`SELECT status FROM sync_jobs`)).rows).toEqual([{ status: 'done' }]);
  });

  /** Devolve o job do chamado 1 à fila já vencido e o pega de novo (simula o backoff passando). */
  async function reclaim(): Promise<Job> {
    await pool.query(`UPDATE sync_jobs SET status = 'pending', next_run_at = now(), lease_token = NULL WHERE ticket_id = 1`);
    const [job] = await claim(pool, { leaseMs: LEASE });
    return job!;
  }
});
