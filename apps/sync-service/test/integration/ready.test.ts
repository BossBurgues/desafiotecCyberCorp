import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/infra/http/server.js';
import { createReadiness, httpHealthCheck, postgresCheck } from '../../src/infra/http/readiness.js';
import { fakeHealthServer, memoryLogger } from '../helpers.js';
import { TEST_DATABASE_URL } from './db.js';

describe.skipIf(!TEST_DATABASE_URL)('/ready com Postgres de verdade', () => {
  const closers: Array<() => Promise<void>> = [];
  let aUrl = '';
  let bUrl = '';

  beforeAll(async () => {
    const a = await fakeHealthServer((res) => res.writeHead(200).end());
    const b = await fakeHealthServer((res) => res.writeHead(200).end());
    aUrl = a.url;
    bUrl = b.url;
    closers.push(a.close, b.close);
  });
  afterAll(async () => {
    for (const close of closers) await close();
  });

  const serverWith = (pool: pg.Pool) =>
    buildServer({
      logger: memoryLogger().logger,
      readiness: createReadiness({
        timeoutMs: 1000,
        checks: { postgres: postgresCheck(pool), system_a: httpHealthCheck(aUrl), system_b: httpHealthCheck(bUrl) },
      }),
    });

  it('200 com Postgres, A e B de pé', async () => {
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    closers.push(() => pool.end());
    const res = await serverWith(pool).inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
  });

  it('503 quando o Postgres não aceita conexão (cenário H5)', async () => {
    // Porta fechada: o mesmo que o Postgres fora do ar
    const pool = new pg.Pool({ connectionString: 'postgres://x:y@127.0.0.1:1/nada', connectionTimeoutMillis: 300 });
    pool.on('error', () => {});
    closers.push(() => pool.end());
    const res = await serverWith(pool).inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks).toMatchObject({ postgres: { ok: false }, system_a: { ok: true }, system_b: { ok: true } });
  });
});
