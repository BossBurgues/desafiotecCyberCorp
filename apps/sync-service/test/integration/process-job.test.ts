import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreateUncertainError, VerifyMismatchError, createProcessJob, getMapping } from '../../src/application/process-job.js';
import { BError } from '../../src/adapters/system-b/errors.js';
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

    it('drift de formato no create (o B gravou, só a resposta mudou): create_uncertain, nunca recria às cegas', async () => {
      B.plan.create.push({ reason: 'schema_drift', persist: true });
      await expect(run()).rejects.toMatchObject({ reason: 'schema_drift' });
      expect(await getMapping(pool, 1)).toMatchObject({ state: 'create_uncertain' });
      // A listagem também vem com drift: a varredura falha (permanente) sem criar nada
      B.plan.list.push({ reason: 'schema_drift' });
      await expect(processJob(await reclaim(), new AbortController().signal)).rejects.toMatchObject({ reason: 'schema_drift' });
      expect(B.calls.create).toBe(1);
      expect(markersInB(1)).toBe(1);
    });

    it('o sync morre entre o create no B e o mapeamento (B3): o retry acha o marcador em vez de criar de novo', async () => {
      // Erro que não é do adapter = o processo caiu no meio; a intenção gravada antes do create fica
      const original = B.client.createRecord;
      B.client.createRecord = async (input, o) => {
        await original(input, o);
        throw new Error('processo morreu antes de gravar o mapeamento');
      };
      await expect(run()).rejects.toThrow('processo morreu');
      B.client.createRecord = original;
      expect(await getMapping(pool, 1)).toMatchObject({ state: 'create_uncertain', b_record_id: null });
      await processJob(await reclaim(), new AbortController().signal);
      expect(markersInB(1)).toBe(1);
      expect(await getMapping(pool, 1)).toMatchObject({ state: 'active', b_record_id: 'B-1' });
    });

    it('falha não ambígua (429, disjuntor aberto) não marca create_uncertain: o B não gravou', async () => {
      B.plan.create.push({ reason: 'rate_limited', status: 429 });
      await expect(run()).rejects.toMatchObject({ reason: 'rate_limited', ambiguous: false });
      expect(await getMapping(pool, 1)).toBeNull();
    });
  });

  describe('verificação pós-escrita (S3.8)', () => {
    const syncedThenChanged = async (name: string) => {
      await run();
      await pool.query(`DELETE FROM sync_jobs`); // o reclaim() pega qualquer job do chamado 1
      A.put(ticket(1, { name, date_mod: '2026-10-18 10:10:00' }));
    };

    it('update confirmado pela leitura grava o hash e o last_written_hash', async () => {
      await run();
      const before = await getMapping(pool, 1);
      await pool.query(`UPDATE sync_jobs SET status = 'done'`);
      A.put(ticket(1, { name: 'Confirmado', date_mod: '2026-10-18 10:10:00' }));
      await run();
      const after = await getMapping(pool, 1);
      expect(after!.last_synced_hash).not.toBe(before!.last_synced_hash);
      expect(after!.last_written_hash).not.toBe(before!.last_written_hash);
      expect(B.calls.get).toBe(2);
    });

    it('B responde 200 ao update sem gravar: hash não é gravado e o job volta para a fila', async () => {
      await syncedThenChanged('Nunca gravado');
      const before = await getMapping(pool, 1);
      B.ackWithoutPersist.update = 1;
      await expect(run()).rejects.toBeInstanceOf(VerifyMismatchError);
      expect(await getMapping(pool, 1)).toMatchObject({ last_synced_hash: before!.last_synced_hash, state: 'active' });
      expect((await audit(1)).at(-1)).toEqual({ action: 'verify', outcome: 'mismatch' });
    });

    it('create com 201 que não aparece na leitura vira create ambíguo, sem recriar na hora', async () => {
      B.ackWithoutPersist.create = 1;
      await expect(run()).rejects.toBeInstanceOf(CreateUncertainError);
      expect(B.calls.create).toBe(1);
      expect(B.records.size).toBe(0);
      expect(await getMapping(pool, 1)).toMatchObject({ state: 'create_uncertain', b_record_id: null });
      expect((await audit(1)).at(-1)).toEqual({ action: 'verify', outcome: 'missing' });

      // N = 2 varreduras sem achar o marcador → recria, e fica um registro só
      await expect(processJob(await reclaim(), new AbortController().signal)).rejects.toBeInstanceOf(CreateUncertainError);
      await processJob(await reclaim(), new AbortController().signal);
      expect(B.calls.create).toBe(2);
      expect(markersInB(1)).toBe(1);
      expect(await getMapping(pool, 1)).toMatchObject({ state: 'active' });
    });

    it('create ambíguo que aparece na varredura é adotado: um registro só', async () => {
      // gravação atrasada: a leitura logo depois do 201 dá 404, mas o registro aparece antes da próxima varredura
      const original = B.client.getRecord;
      B.client.getRecord = async () => null;
      await expect(run()).rejects.toBeInstanceOf(CreateUncertainError);
      B.client.getRecord = original;
      await processJob(await reclaim(), new AbortController().signal);
      expect(B.calls.create).toBe(1);
      expect(markersInB(1)).toBe(1);
      expect(await getMapping(pool, 1)).toMatchObject({ state: 'active', b_record_id: 'B-1' });
    });

    it('update em registro que sumiu e cujo marcador está na listagem adota o registro', async () => {
      await syncedThenChanged('Depois de mudar de ID');
      // o registro ganhou outro ID no B (ex.: restaurado de backup): B-1 some, B-9 tem o marcador
      const old = B.records.get('B-1')!;
      B.records.delete('B-1');
      B.records.set('B-9', { ...old, id: 'B-9' });
      await run();
      expect(B.calls.create).toBe(1);
      expect(B.records.get('B-9')!.title).toBe('Depois de mudar de ID');
      expect(await getMapping(pool, 1)).toMatchObject({ state: 'active', b_record_id: 'B-9' });
      expect((await audit(1)).map((r) => `${r.action}:${r.outcome}`)).toEqual([
        'create:ok',
        'record_missing:not_found',
        'adopt:found_by_marker',
        'update:ok',
      ]);
    });

    it('update em registro que sumiu sem marcador na listagem recria depois de N varreduras', async () => {
      await syncedThenChanged('Recriado');
      B.records.delete('B-1');
      await expect(run()).rejects.toBeInstanceOf(CreateUncertainError);
      expect(await getMapping(pool, 1)).toMatchObject({ state: 'create_uncertain', b_record_id: null, uncertain_scans: 1 });
      await processJob(await reclaim(), new AbortController().signal);
      expect(B.calls.create).toBe(2);
      expect(markersInB(1)).toBe(1);
      expect([...B.records.values()][0]!.title).toBe('Recriado');
      const { rows } = await pool.query(`SELECT b_record_history FROM ticket_mapping WHERE a_ticket_id = 1`);
      expect(rows[0].b_record_history).toEqual(['B-1']);
    });

    it('erro na leitura de verificação é transitório e não grava o hash', async () => {
      await syncedThenChanged('Leitura falhou');
      const before = await getMapping(pool, 1);
      B.client.getRecord = async () => {
        throw new BError('timeout', 'GET: timeout');
      };
      await expect(run()).rejects.toMatchObject({ reason: 'timeout', errorClass: 'transient' });
      expect((await getMapping(pool, 1))!.last_synced_hash).toBe(before!.last_synced_hash);
    });

    it('VERIFY_AFTER_WRITE=false pula a leitura', async () => {
      processJob = createProcessJob({
        pool,
        a: A.client,
        b: B.client,
        logger,
        timeZone: TZ,
        markerField: 'description',
        uncertainScans: 2,
        listPageSize: 100,
        verifyAfterWrite: false,
      });
      await syncedThenChanged('Sem leitura');
      await run();
      expect(B.calls).toMatchObject({ create: 1, update: 1, get: 0 });
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
