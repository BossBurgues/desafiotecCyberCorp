import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProcessJob, getMapping } from '../../src/application/process-job.js';
import { reconcileMappings } from '../../src/application/reconcile.js';
import { migrate } from '../../src/infra/db/migrate.js';
import { enqueue } from '../../src/infra/queue/queue.js';
import { drain } from '../../src/infra/queue/runner.js';
import { fakeA, fakeB, ticket } from '../fakes.js';
import { memoryLogger } from '../helpers.js';
import { TEST_DATABASE_URL, isolatedPool } from './db.js';

/**
 * Banco do sync perdido (ou restaurado de um backup antigo): o poller relê o A desde o início e o worker não acha
 * mapeamento. Sem a reconciliação pelo marcador, cada chamado seria criado de novo no B (duplicata).
 */
describe.skipIf(!TEST_DATABASE_URL)('reconciliação pelo marcador depois de perder o banco do sync', () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  const { logger } = memoryLogger('silent');
  let A: ReturnType<typeof fakeA>;
  let B: ReturnType<typeof fakeB>;

  const processor = () =>
    createProcessJob({
      pool,
      a: A.client,
      b: B.client,
      logger,
      timeZone: 'America/Sao_Paulo',
      markerField: 'description',
      uncertainScans: 2,
      listPageSize: 100,
    });
  const work = async () => {
    await pool.query(`UPDATE sync_jobs SET next_run_at = now() WHERE status = 'pending'`);
    await drain({ pool, processor: processor(), logger, leaseMs: 60_000, maxJobs: 20 });
  };
  const reconcile = () => reconcileMappings({ pool, b: B.client, logger, markerField: 'description', pageSize: 100 });
  /** O que sobra de um banco perdido: nada do estado do sync. */
  const loseSyncDatabase = () => pool.query('TRUNCATE ticket_mapping, sync_jobs, poll_checkpoint, audit_log CASCADE');

  beforeEach(async () => {
    ({ pool, drop } = await isolatedPool());
    await migrate(pool, logger);
    A = fakeA([ticket(1), ticket(2)]);
    B = fakeB();
    await enqueue(pool, 1);
    await enqueue(pool, 2);
    await work();
    expect(B.records.size).toBe(2);
  });
  afterEach(async () => drop());

  it('adota os registros do B pelo marcador: reprocessar tudo atualiza, sem criar de novo', async () => {
    await loseSyncDatabase();
    A.put(ticket(1, { name: 'Editado depois da perda', date_mod: '2026-10-18 12:00:00' }));

    const result = await reconcile();
    expect(result).toMatchObject({ adopted: 2, duplicated: [], complete: true });

    // O poller, sem checkpoint, enfileira todo o A de novo
    await enqueue(pool, 1);
    await enqueue(pool, 2);
    const creates = B.calls.create;
    await work();

    expect(B.calls.create).toBe(creates);
    expect(B.records.size).toBe(2);
    expect(B.records.get('B-1')!.title).toBe('Editado depois da perda');
    expect((await getMapping(pool, 1))?.b_record_id).toBe('B-1');
  });

  it('sem a reconciliação o mesmo reprocessamento duplicaria (o defeito que ela evita)', async () => {
    await loseSyncDatabase();
    await enqueue(pool, 1);
    await work();
    expect(B.records.size).toBe(3);
  });

  it('duplicata antiga no B: adota o registro mais antigo e avisa', async () => {
    const original = B.records.get('B-1')!;
    B.records.set('B-9', { ...original, id: 'B-9', createdAt: '2099-01-01T00:00:00.000Z' });
    await loseSyncDatabase();

    const result = await reconcile();
    expect(result.duplicated).toEqual([1]);
    expect((await getMapping(pool, 1))?.b_record_id).toBe('B-1');
  });

  it('não mexe em mapeamento que já existe', async () => {
    const adopted = await reconcile();
    expect(adopted.adopted).toBe(0);
    expect((await getMapping(pool, 1))?.last_synced_hash).not.toBeNull();
  });

  it('registro sem marcador (criado à mão no B) não é adotado', async () => {
    B.records.set('B-7', { ...B.records.get('B-2')!, id: 'B-7', description: 'Criado pelo operador' });
    await loseSyncDatabase();
    expect((await reconcile()).adopted).toBe(2);
    expect(await getMapping(pool, 7)).toBeNull();
  });

  it('listagem do B falha → a reconciliação falha (e o worker continua parado até ela completar)', async () => {
    await loseSyncDatabase();
    B.plan.list.push({ reason: 'server_error' });
    await expect(reconcile()).rejects.toThrow();
    expect((await reconcile()).complete).toBe(true);
  });
});
