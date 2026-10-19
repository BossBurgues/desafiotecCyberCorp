import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanOnce } from '../../src/application/b-scanner.js';
import { createProcessJob, getMapping } from '../../src/application/process-job.js';
import type { BRecordResponse } from '../../src/adapters/system-b/client.js';
import { migrate } from '../../src/infra/db/migrate.js';
import { enqueue } from '../../src/infra/queue/queue.js';
import { drain, type JobProcessor } from '../../src/infra/queue/runner.js';
import { fakeA, fakeB, ticket } from '../fakes.js';
import { memoryLogger } from '../helpers.js';
import { TEST_DATABASE_URL, isolatedPool } from './db.js';

const LEASE = 60_000;

/**
 * B → A leve (ADR-014), as duas perguntas do avaliador:
 * (1) como uma atualização não fica indo e voltando entre os sistemas;
 * (2) o que acontece quando os dois alteram o mesmo chamado ao mesmo tempo.
 */
describe.skipIf(!TEST_DATABASE_URL)('B → A leve: estado, quem alterou e solução voltam ao A sem eco', () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  const { logger } = memoryLogger('silent');
  let A: ReturnType<typeof fakeA>;
  let B: ReturnType<typeof fakeB>;

  const processor = (bToA: boolean): JobProcessor =>
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

  beforeEach(async () => {
    ({ pool, drop } = await isolatedPool());
    await migrate(pool, logger);
    A = fakeA([ticket(1, { status: 2 })]);
    B = fakeB();
  });
  afterEach(async () => drop());

  const due = () => pool.query(`UPDATE sync_jobs SET next_run_at = now() WHERE status = 'pending'`);
  const work = async (p: JobProcessor) => {
    await due();
    await drain({ pool, processor: p, logger, leaseMs: LEASE, maxJobs: 10 });
  };
  const scan = () => scanOnce({ pool, b: B.client, logger, markerField: 'description', pageSize: 100 });
  /** O operador do B muda o registro pela UI dele (fora da API do sync), com o nome dele como autor. */
  const operator = (changes: Partial<BRecordResponse>, by: string | null = 'Carla (suporte)') => {
    const rec = B.records.get('B-1')!;
    B.records.set('B-1', { ...rec, ...changes, updatedBy: by, updatedAt: new Date().toISOString() });
  };
  /** O que o A faria ao mudar o chamado: o webhook/poller enfileira um job comum. */
  const aChanged = async () => enqueue(pool, 1);
  const audit = async () =>
    (await pool.query(`SELECT action, outcome FROM audit_log WHERE direction = 'b_to_a' ORDER BY id`)).rows.map(
      (r) => `${r.action}:${r.outcome}`,
    );

  beforeEach(async () => {
    // O chamado nasce no A e chega ao B (núcleo A → B)
    await enqueue(pool, 1);
    await work(processor(true));
    expect(B.records.get('B-1')!.state).toBe('IN_PROGRESS');
  });

  it('o operador do B fecha com solução → o A fica Fechado, com nota de quem alterou e da solução', async () => {
    operator({ state: 'CLOSED', resolution: 'Toner trocado.' });
    expect((await scan()).changed).toBe(1);
    await work(processor(true));

    expect(A.tickets.get(1)!.status).toBe(6);
    const [note] = A.followups.get(1)!;
    expect(note).toContain('Estado alterado no Sistema B por Carla (suporte): Em andamento → Fechado.');
    expect(note).toContain('Solução: Toner trocado.');
    expect(note).toContain('⟦from-b:B-1⟧');
    expect(await audit()).toEqual(['b_state:applied_to_a']);
  });

  it('(1) sem ida e volta: depois de aplicar no A, três ciclos seguidos não escrevem nada em nenhum lado', async () => {
    operator({ state: 'RESOLVED', resolution: 'Reiniciada.' });
    await scan();
    await work(processor(true));
    const writesInB = B.calls.update + B.calls.create;
    const writesInA = A.statusWrites.length;

    for (let cycle = 0; cycle < 3; cycle++) {
      // a escrita do sync-bot no A gera um evento (poller), e a varredura do B roda de novo
      await aChanged();
      await scan();
      await work(processor(true));
    }
    expect(B.calls.update + B.calls.create).toBe(writesInB);
    expect(A.statusWrites.length).toBe(writesInA);
    expect(A.followups.get(1)).toHaveLength(1);
    expect((await scan()).changed).toBe(0);
  });

  it('o operador do B reabre um chamado fechado → o A volta para Novo', async () => {
    operator({ state: 'CLOSED' });
    await scan();
    await work(processor(true));
    operator({ state: 'OPEN' }, 'Diego');
    await scan();
    await work(processor(true));
    expect(A.tickets.get(1)!.status).toBe(1);
    expect(A.followups.get(1)!.at(-1)).toContain('por Diego: Fechado → Aberto.');
  });

  it('(2) A e B mudam o estado ao mesmo tempo: o A vence, o B é sobrescrito e o A ganha uma nota do conflito', async () => {
    operator({ state: 'CLOSED' });
    A.put(ticket(1, { status: 4, date_mod: '2026-10-18 10:30:00' })); // o Técnico pôs Pendente
    await aChanged();
    await scan();
    await work(processor(true));

    expect(A.tickets.get(1)!.status).toBe(4);
    expect(B.records.get('B-1')!.state).toBe('ON_HOLD');
    expect(A.followups.get(1)![0]).toContain('prevaleceu o A');
    expect(await audit()).toEqual(['conflict:a_wins']);
  });

  it('o B edita o título: o A é a fonte da verdade, o título volta e o A ganha uma nota', async () => {
    operator({ title: 'Título trocado no B' });
    await scan();
    await work(processor(true));
    expect(B.records.get('B-1')!.title).toBe('Chamado 1');
    expect(A.followups.get(1)![0]).toContain('alterou o título');
    expect(await audit()).toEqual(['b_edit:reverted']);
  });

  it('o A edita outro campo depois que o B fechou: o B continua fechado, recebe a edição e guarda a solução', async () => {
    operator({ state: 'CLOSED', resolution: 'Peça trocada.' });
    // o A muda antes da próxima varredura: o próprio job do A lê o B antes de escrever
    A.put(ticket(1, { status: 2, name: 'Título novo no A', date_mod: '2026-10-18 10:40:00' }));
    await aChanged();
    await work(processor(true));

    expect(B.records.get('B-1')).toMatchObject({ title: 'Título novo no A', state: 'CLOSED', resolution: 'Peça trocada.' });
    expect(A.tickets.get(1)!.status).toBe(6);
  });

  it('com o B → A desligado, o B fechado não é reaberto por uma edição no A, e o A não muda', async () => {
    operator({ state: 'CLOSED' });
    A.put(ticket(1, { status: 2, name: 'Edição no A', date_mod: '2026-10-18 10:50:00' }));
    await aChanged();
    await work(processor(false));

    expect(B.records.get('B-1')).toMatchObject({ title: 'Edição no A', state: 'CLOSED' });
    expect(A.tickets.get(1)!.status).toBe(2);
    expect(A.followups.get(1)).toBeUndefined();
    expect(await audit()).toEqual(['b_state:kept_in_b']);
  });

  it('autor não informado pelo B aparece assim na nota', async () => {
    operator({ state: 'RESOLVED' }, null);
    await scan();
    await work(processor(true));
    expect(A.followups.get(1)![0]).toContain('por autor não informado pelo B');
  });

  it('o mapeamento guarda o que foi escrito por último (base da comparação campo a campo)', async () => {
    const m = await getMapping(pool, 1);
    expect(m!.last_written_record).toMatchObject({ title: 'Chamado 1', state: 'IN_PROGRESS' });
  });
});
