import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/infra/db/migrate.js';
import { memoryLogger } from '../helpers.js';
import { TEST_DATABASE_URL, isolatedPool } from './db.js';

const SECTION_8_TABLES = [
  'alerts_outbox',
  'audit_log',
  'inbound_events',
  'note_mapping',
  'poll_checkpoint',
  'proposals',
  'sync_jobs',
  'ticket_mapping',
];

describe.skipIf(!TEST_DATABASE_URL)('migrations (Postgres de verdade)', () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  const { logger } = memoryLogger();

  beforeEach(async () => {
    ({ pool, drop } = await isolatedPool());
  });
  afterEach(async () => drop());

  const tables = async () =>
    (
      await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1`,
      )
    ).rows.map((r) => r.table_name);

  it('cria todas as tabelas da seção 8 do plano', async () => {
    expect(await migrate(pool, logger)).toEqual(['001_initial.sql', '002_queue_lease_rerun.sql', '003_process_job.sql']);
    expect(await tables()).toEqual([...SECTION_8_TABLES, 'schema_migrations'].sort());
  });

  it('rodar de novo não reaplica nada (subir duas vezes é seguro)', async () => {
    await migrate(pool, logger);
    expect(await migrate(pool, logger)).toEqual([]);
  });

  it('duas instâncias subindo juntas aplicam cada migration uma vez só', async () => {
    const [a, b] = await Promise.all([migrate(pool, logger), migrate(pool, logger)]);
    expect([...a, ...b].sort()).toEqual(['001_initial.sql', '002_queue_lease_rerun.sql', '003_process_job.sql']);
  });

  it('só um job ativo por chamado; depois de done, outro pode entrar (ADR-002)', async () => {
    await migrate(pool, logger);
    await pool.query(`INSERT INTO sync_jobs (ticket_id, kind) VALUES (42, 'sync_ticket')`);
    await expect(pool.query(`INSERT INTO sync_jobs (ticket_id, kind) VALUES (42, 'sync_ticket')`)).rejects.toThrow(
      /sync_jobs_one_active_per_ticket/,
    );
    await pool.query(`UPDATE sync_jobs SET status = 'done' WHERE ticket_id = 42`);
    await pool.query(`INSERT INTO sync_jobs (ticket_id, kind) VALUES (42, 'sync_ticket')`);
  });

  it('estados fora da lista são recusados pelo banco', async () => {
    await migrate(pool, logger);
    await expect(pool.query(`INSERT INTO sync_jobs (ticket_id, kind, status) VALUES (1, 'x', 'perdido')`)).rejects.toThrow();
    await expect(pool.query(`INSERT INTO ticket_mapping (a_ticket_id, state) VALUES (1, 'sumido')`)).rejects.toThrow();
    await expect(pool.query(`INSERT INTO inbound_events (source, ticket_id) VALUES ('email', 1)`)).rejects.toThrow();
  });

  it('b_record_id é único, mas vários create_uncertain podem ficar sem ID do B', async () => {
    await migrate(pool, logger);
    await pool.query(`INSERT INTO ticket_mapping (a_ticket_id, state) VALUES (1, 'create_uncertain'), (2, 'create_uncertain')`);
    await pool.query(`INSERT INTO ticket_mapping (a_ticket_id, b_record_id) VALUES (3, 'B-1')`);
    await expect(pool.query(`INSERT INTO ticket_mapping (a_ticket_id, b_record_id) VALUES (4, 'B-1')`)).rejects.toThrow();
  });

  it('migration com erro não deixa nada pela metade e impede a subida', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sync-migrations-'));
    await writeFile(join(dir, '001_ok.sql'), 'CREATE TABLE ok_table (id int);');
    await writeFile(join(dir, '002_quebrada.sql'), 'CREATE TABLE meia (id int); SELECT * FROM tabela_que_nao_existe;');

    await expect(migrate(pool, logger, dir)).rejects.toThrow(/migration 002_quebrada\.sql falhou/);
    expect(await tables()).toEqual(['ok_table', 'schema_migrations']);
    const names = (await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name);
    expect(names).toEqual(['001_ok.sql']);
  });
});
