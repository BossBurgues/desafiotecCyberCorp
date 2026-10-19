import type { InjectOptions } from 'fastify';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/infra/db/migrate.js';
import { dashboardPlugin, type DashboardOptions } from '../../src/infra/http/dashboard.js';
import { createReadiness } from '../../src/infra/http/readiness.js';
import { buildServer } from '../../src/infra/http/server.js';
import { claim, enqueue, fail } from '../../src/infra/queue/queue.js';
import { memoryLogger } from '../helpers.js';
import { TEST_DATABASE_URL, isolatedPool } from './db.js';

describe.skipIf(!TEST_DATABASE_URL)('dashboard básico (S3.10)', () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  const { logger } = memoryLogger('silent');

  beforeEach(async () => {
    ({ pool, drop } = await isolatedPool());
    await migrate(pool, logger);
  });
  afterEach(async () => drop());

  const AUTH = { user: 'operador', password: 'senha-de-teste-123' };
  const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

  /** Servidor sem login automático: para os testes do H2. */
  const rawServer = (overrides: Partial<DashboardOptions> = {}) =>
    buildServer({
      logger,
      readiness: createReadiness({ timeoutMs: 100, checks: {} }),
      plugins: [dashboardPlugin({ pool, breakerState: () => 'open', controlsEnabled: true, auth: AUTH, ...overrides })],
    });

  /** Servidor em que toda requisição já vai com o login certo (os testes da S3.10 não mudam). */
  const server = (overrides: Partial<DashboardOptions> = {}) => {
    const app = rawServer(overrides);
    const inject = app.inject.bind(app);
    app.inject = ((opts: InjectOptions) =>
      inject({ ...opts, headers: { authorization: basic(AUTH.user, AUTH.password), ...opts.headers } })) as typeof app.inject;
    return app;
  };

  /** Um job em cada status, um deles na DLQ, dois mapeamentos e um alerta. */
  async function seed(): Promise<number> {
    await enqueue(pool, 1);
    await enqueue(pool, 2);
    await enqueue(pool, 3);
    const [dead] = await claim(pool, { leaseMs: 60_000 });
    await fail(pool, dead!, { errorClass: 'permanent', message: 'B recusou: 422 title' }, { baseMs: 1, maxDelayMs: 1, transientMaxAgeMs: 1, permanentMaxAttempts: 1 });
    await claim(pool, { leaseMs: 60_000 }); // fica running
    await pool.query(`INSERT INTO ticket_mapping (a_ticket_id, b_record_id, state) VALUES (10, 'B-10', 'active'), (11, NULL, 'create_uncertain')`);
    return dead!.id;
  }

  it('resumo: contadores por status, DLQ com o motivo, mapeamentos, alertas e o disjuntor', async () => {
    const deadId = await seed();
    const res = await server().inject({ method: 'GET', url: '/api/dashboard/summary' });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.jobs).toEqual({ pending: 1, running: 1, done: 0, dead: 1 });
    expect(s.dlq).toEqual([expect.objectContaining({ id: deadId, ticket_id: 1, error_class: 'permanent', last_error: 'B recusou: 422 title' })]);
    expect(s.mappings).toMatchObject({ active: 1, create_uncertain: 1, quarantine: 0 });
    expect(s.alerts).toEqual([expect.objectContaining({ kind: 'dlq', ticket_id: 1 })]);
    expect(s).toMatchObject({ breaker: 'open', controlsEnabled: true, chaosAvailable: false });
  });

  it('/metrics no formato do Prometheus, com todas as séries mesmo zeradas', async () => {
    await seed();
    const res = await server().inject({ method: 'GET', url: '/metrics' });
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.body).toContain('sync_jobs{status="dead"} 1');
    expect(res.body).toContain('sync_jobs{status="done"} 0');
    expect(res.body).toContain('sync_dlq_pending 1');
    expect(res.body).toContain('sync_ticket_mappings{state="archived"} 0');
    expect(res.body).toContain('sync_b_circuit_breaker 2');
    expect(res.body).toMatch(/# TYPE sync_jobs gauge/);
  });

  it('reprocessar da DLQ cria um job novo para o chamado e tira o item da lista', async () => {
    const deadId = await seed();
    await pool.query(`UPDATE sync_jobs SET status = 'done' WHERE ticket_id = 1 AND status <> 'dead'`);
    const app = server();
    const res = await app.inject({ method: 'POST', url: `/api/dashboard/dlq/${deadId}/reprocess` });
    expect(res.statusCode).toBe(200);
    const { jobId } = res.json();
    expect((await pool.query(`SELECT ticket_id, status FROM sync_jobs WHERE id = $1`, [jobId])).rows[0]).toEqual({ ticket_id: '1', status: 'pending' });
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/summary' })).json().dlq).toEqual([]);
    // Reprocessar de novo o mesmo item: já não está na DLQ
    expect((await app.inject({ method: 'POST', url: `/api/dashboard/dlq/${deadId}/reprocess` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/dashboard/dlq/abc/reprocess' })).statusCode).toBe(400);
  });

  it('controles desligados: reprocessar e mexer no caos respondem 403, a leitura continua', async () => {
    const deadId = await seed();
    const app = server({ controlsEnabled: false, bAdmin: { baseUrl: 'http://b.test', token: 't', fetch: (async () => new Response('{}')) as typeof fetch } });
    expect((await app.inject({ method: 'POST', url: `/api/dashboard/dlq/${deadId}/reprocess` })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/dashboard/chaos', payload: { errorRate: 1 } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/dashboard/chaos/reset' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/summary' })).statusCode).toBe(200);
    expect((await pool.query(`SELECT count(*)::int AS n FROM sync_jobs WHERE status = 'dead' AND reprocessed_at IS NULL`)).rows[0].n).toBe(1);
  });

  it('painel de caos repassa ao /admin/chaos do B com o X-Admin-Token', async () => {
    const calls: { url: string; method: string; token: string; body: string | undefined }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method!, token: (init.headers as Record<string, string>)['x-admin-token']!, body: init.body as string | undefined });
      return new Response(JSON.stringify({ errorRate: 0.5 }), { status: 200 });
    }) as unknown as typeof fetch;
    const app = server({ bAdmin: { baseUrl: 'http://b.test', token: 'segredo-admin', fetch: fakeFetch } });
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/chaos' })).json()).toEqual({ errorRate: 0.5 });
    await app.inject({ method: 'PUT', url: '/api/dashboard/chaos', payload: { errorRate: 0.5 } });
    await app.inject({ method: 'POST', url: '/api/dashboard/chaos/reset' });
    expect(calls).toEqual([
      { url: 'http://b.test/admin/chaos', method: 'GET', token: 'segredo-admin', body: undefined },
      { url: 'http://b.test/admin/chaos', method: 'PUT', token: 'segredo-admin', body: '{"errorRate":0.5}' },
      { url: 'http://b.test/admin/chaos/reset', method: 'POST', token: 'segredo-admin', body: undefined },
    ]);
  });

  it('sem B_ADMIN_TOKEN o painel de caos fica desligado (503)', async () => {
    expect((await server().inject({ method: 'GET', url: '/api/dashboard/chaos' })).statusCode).toBe(503);
  });

  it('GET /dashboard serve a página com CSP', async () => {
    const res = await server().inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.body).toContain('/api/dashboard/summary');
    // Nada vindo da API vira HTML: a página não usa innerHTML
    expect(res.body).not.toMatch(/innerHTML/);
  });
  describe('H2: login do dashboard (S5.3)', () => {
    it('sem credenciais o dashboard, a API e o /metrics respondem 401 com WWW-Authenticate', async () => {
      const app = rawServer();
      for (const [method, url] of [
        ['GET', '/dashboard'],
        ['GET', '/api/dashboard/summary'],
        ['GET', '/metrics'],
        ['GET', '/api/dashboard/chaos'],
        ['PUT', '/api/dashboard/chaos'],
        ['POST', '/api/dashboard/chaos/reset'],
        ['POST', '/api/dashboard/dlq/1/reprocess'],
      ] as const) {
        const res = await app.inject({ method, url });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
        expect(res.headers['www-authenticate']).toMatch(/^Basic realm="sync-dashboard"/);
      }
    });

    it('senha errada ou usuário errado responde 401', async () => {
      const app = rawServer();
      const wrong = [basic(AUTH.user, 'senha-errada-0000'), basic('outro', AUTH.password), 'Basic !!!', 'Bearer x'];
      for (const authorization of wrong) {
        expect((await app.inject({ method: 'GET', url: '/api/dashboard/summary', headers: { authorization } })).statusCode).toBe(401);
      }
    });

    it('com credenciais corretas o resumo responde 200', async () => {
      const res = await rawServer().inject({
        method: 'GET',
        url: '/api/dashboard/summary',
        headers: { authorization: basic(AUTH.user, AUTH.password) },
      });
      expect(res.statusCode).toBe(200);
    });

    it('/health e /ready continuam sem login', async () => {
      const app = rawServer();
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).not.toBe(401);
    });

    it('sem o plugin do dashboard (sem credenciais configuradas) as rotas respondem 404', async () => {
      const app = buildServer({ logger, readiness: createReadiness({ timeoutMs: 100, checks: {} }), plugins: [] });
      expect((await app.inject({ method: 'GET', url: '/dashboard' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
    });
  });
});
