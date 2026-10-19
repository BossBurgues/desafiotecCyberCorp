import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanOnce } from '../../src/application/b-scanner.js';
import { pollOnce } from '../../src/application/poller.js';
import { createProcessJob, getMapping } from '../../src/application/process-job.js';
import { migrate } from '../../src/infra/db/migrate.js';
import { enqueue } from '../../src/infra/queue/queue.js';
import { drain, type JobProcessor } from '../../src/infra/queue/runner.js';
import { fakeA, fakeB, ticket } from '../fakes.js';
import { memoryLogger } from '../helpers.js';
import { TEST_DATABASE_URL, isolatedPool } from './db.js';

const LEASE = 60_000;

/**
 * Exclusão nos dois lados (ADR-015). O A é o mestre: excluir no A apaga no B; excluir no B leva o chamado para a
 * lixeira do A, a não ser que o A tenha mudado o chamado depois da última sincronização (aí o A vence e recria).
 */
describe.skipIf(!TEST_DATABASE_URL)('exclusão nos dois lados: lixeira do A e lápide do B', () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  const { logger } = memoryLogger('silent');
  let A: ReturnType<typeof fakeA>;
  let B: ReturnType<typeof fakeB>;

  const processor = (bToA = true): JobProcessor =>
    createProcessJob({
      pool,
      a: A.client,
      b: B.client,
      logger,
      timeZone: 'America/Sao_Paulo',
      markerField: 'description',
      uncertainScans: 2,
      listPageSize: 100,
      bToA,
    });

  const due = () => pool.query(`UPDATE sync_jobs SET next_run_at = now() WHERE status = 'pending'`);
  const work = async (p: JobProcessor = processor()) => {
    await due();
    await drain({ pool, processor: p, logger, leaseMs: LEASE, maxJobs: 10 });
  };
  const scan = () => scanOnce({ pool, b: B.client, logger, markerField: 'description', pageSize: 100 });
  const poll = () => pollOnce({ pool, a: A.client, logger, timeZone: 'America/Sao_Paulo', overlapMs: 120_000, pageSize: 50 });
  /** O Técnico mexe no chamado pelo A (renova o date_mod, como o GLPI) e o webhook enfileira o job. */
  const aEdits = async (changes: Partial<ReturnType<typeof ticket>>, at: string) => {
    A.put({ ...A.tickets.get(1)!, ...changes, date_mod: at });
    await enqueue(pool, 1);
  };
  const audit = async () =>
    (await pool.query(`SELECT action, outcome FROM audit_log WHERE action IN ('delete', 'b_delete') ORDER BY id`)).rows.map(
      (r) => `${r.action}:${r.outcome}`,
    );

  beforeEach(async () => {
    ({ pool, drop } = await isolatedPool());
    await migrate(pool, logger);
    A = fakeA([ticket(1)]);
    B = fakeB();
    await enqueue(pool, 1);
    await work();
    expect(B.records.has('B-1')).toBe(true);
  });
  afterEach(async () => drop());

  it('bug de 19/10: o operador exclui no B → a próxima varredura leva o chamado para a lixeira do A, com nota', async () => {
    B.operatorDelete('B-1', 'Maria');

    expect((await scan()).missing).toBe(1);
    await work();

    expect(A.tickets.get(1)!.is_deleted).toBe(1);
    const [note] = A.followups.get(1)!;
    expect(note).toContain('Excluído no Sistema B por Maria em 2026-10-18 11:30:00');
    expect(note).toContain('⟦from-b:B-1⟧');
    expect((await getMapping(pool, 1))!.state).toBe('archived');
    expect(await audit()).toEqual(['b_delete:trashed_in_a']);

    // Sem eco: o poller vê o chamado na lixeira com o hash já sincronizado, e nada mais acontece no B
    const creates = B.calls.create;
    expect((await poll()).enqueued).toBe(0);
    expect((await scan()).missing).toBe(0);
    await work();
    expect(B.calls.create).toBe(creates);
  });

  it('a listagem do B pula a página: o GET confirma que o registro está lá e nada acontece', async () => {
    B.hideFromList(1);
    expect((await scan()).missing).toBe(0);
    expect((await pool.query(`SELECT 1 FROM sync_jobs WHERE status = 'pending'`)).rowCount).toBe(0);
  });

  it('o B perdeu o registro (404, sem lápide) → recria a partir do A, sem ir para a lixeira (S3.8)', async () => {
    B.records.delete('B-1');
    expect((await scan()).missing).toBe(1);
    await work();
    await work();
    expect(A.tickets.get(1)!.is_deleted).toBeUndefined();
    const mapping = (await getMapping(pool, 1))!;
    expect(mapping.state).toBe('active');
    expect(mapping.b_record_id).not.toBe('B-1');
  });

  it('o B exclui, mas o A mudou o chamado depois da última sincronização → o A vence e recria no B, com nota', async () => {
    B.operatorDelete('B-1', 'Maria');
    await aEdits({ name: 'Impressora parada (urgente)' }, '2026-10-18 10:05:00');
    await work();

    expect(A.tickets.get(1)!.is_deleted).toBeUndefined();
    const mapping = (await getMapping(pool, 1))!;
    expect(mapping.state).toBe('active');
    expect(B.records.get(mapping.b_record_id!)!.title).toBe('Impressora parada (urgente)');
    expect(A.followups.get(1)![0]).toContain('prevaleceu o A e o registro foi recriado no B');
    expect(await audit()).toEqual(['b_delete:a_wins']);
  });

  it('com o B → A desligado, a exclusão no B é desfeita: o A é o mestre e recria', async () => {
    B.operatorDelete('B-1');
    await scan();
    await work(processor(false));
    expect(A.tickets.get(1)!.is_deleted).toBeUndefined();
    expect((await getMapping(pool, 1))!.state).toBe('active');
    expect(A.followups.get(1)).toBeUndefined();
  });

  it('o Técnico exclui no A → o registro é excluído no B (lápide do sync) e restaurar recria, sem duplicar', async () => {
    await aEdits({ is_deleted: 1 }, '2026-10-18 10:05:00');
    await work();
    expect(B.tombstones.get('B-1')!.deletedBy).toBe('integração (sync)');
    expect((await getMapping(pool, 1))!.state).toBe('archived');
    expect(await audit()).toEqual(['delete:deleted']);

    // Sem eco nem repetição: o poller vê o chamado na lixeira já sincronizado
    expect((await poll()).enqueued).toBe(0);

    await aEdits({ is_deleted: 0 }, '2026-10-18 10:06:00');
    await work();
    const mapping = (await getMapping(pool, 1))!;
    expect(mapping.state).toBe('active');
    expect(mapping.b_record_id).toBe('B-2');
    expect([...B.records.keys()]).toEqual(['B-2']);
    const { rows } = await pool.query(`SELECT b_record_history FROM ticket_mapping WHERE a_ticket_id = 1`);
    expect(rows[0].b_record_history).toEqual(['B-1']);
  });

  it('webhook perdido: o poller acha o chamado na lixeira do A e o job exclui no B', async () => {
    A.put({ ...A.tickets.get(1)!, is_deleted: 1, date_mod: '2026-10-18 10:05:00' });
    expect((await poll()).enqueued).toBe(1);
    await work();
    expect(B.tombstones.has('B-1')).toBe(true);
  });

  it('os dois excluem ao mesmo tempo: o DELETE do sync recebe 410 e conta como feito', async () => {
    B.operatorDelete('B-1', 'Maria');
    await aEdits({ is_deleted: 1 }, '2026-10-18 10:05:00');
    await work();
    expect((await getMapping(pool, 1))!.state).toBe('archived');
    expect(await audit()).toEqual(['delete:already_deleted']);
    expect(B.calls.create).toBe(1);
  });
});
