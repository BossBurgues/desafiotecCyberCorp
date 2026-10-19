import { afterEach, describe, expect, it } from 'vitest';
import { createReadiness, httpHealthCheck, postgresCheck } from '../../../src/infra/http/readiness.js';
import { fakeHealthServer } from '../../helpers.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

describe('createReadiness', () => {
  it('antes da primeira checagem não está pronto', () => {
    const r = createReadiness({ checks: {}, timeoutMs: 100 });
    expect(r.isReady()).toBe(false);
    expect(r.last()).toBeNull();
  });

  it('fica pronto só quando todas as dependências respondem', async () => {
    let bUp = false;
    const r = createReadiness({
      timeoutMs: 200,
      checks: {
        postgres: async () => {},
        system_b: async () => {
          if (!bUp) throw new Error('connect ECONNREFUSED');
        },
      },
    });

    const down = await r.refresh();
    expect(down.ready).toBe(false);
    expect(down.checks.postgres!.ok).toBe(true);
    expect(down.checks.system_b).toMatchObject({ ok: false, error: 'connect ECONNREFUSED' });
    expect(r.isReady()).toBe(false);

    bUp = true;
    expect((await r.refresh()).ready).toBe(true);
    expect(r.isReady()).toBe(true);
  });

  it('dependência que trava conta como fora do ar depois do timeout e a checagem é cancelada', async () => {
    let aborted = false;
    const r = createReadiness({
      timeoutMs: 50,
      checks: {
        lento: (signal) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              resolve();
            });
          }),
      },
    });
    const report = await r.refresh();
    expect(report.checks.lento).toMatchObject({ ok: false, error: 'sem resposta em 50 ms' });
    expect(aborted).toBe(true);
  });
});

describe('httpHealthCheck', () => {
  it('2xx no /health passa e 5xx falha com o status na mensagem', async () => {
    const ok = await fakeHealthServer((res) => res.writeHead(200).end('{"status":"ok"}'));
    const broken = await fakeHealthServer((res) => res.writeHead(503).end());
    closers.push(ok.close, broken.close);

    const r = createReadiness({
      timeoutMs: 1000,
      checks: { a: httpHealthCheck(ok.url), b: httpHealthCheck(broken.url) },
    });
    const report = await r.refresh();
    expect(report.checks.a!.ok).toBe(true);
    expect(report.checks.b).toMatchObject({ ok: false, error: 'GET /health respondeu 503' });
  });

  it('servidor que nunca responde cai no timeout', async () => {
    const hung = await fakeHealthServer(() => {});
    closers.push(hung.close);
    const r = createReadiness({ timeoutMs: 100, checks: { b: httpHealthCheck(hung.url) } });
    expect((await r.refresh()).checks.b).toMatchObject({ ok: false });
  });
});

describe('postgresCheck', () => {
  it('roda SELECT 1 e propaga a falha', async () => {
    const queries: string[] = [];
    await postgresCheck({ query: async (sql) => void queries.push(sql) })(new AbortController().signal);
    expect(queries).toEqual(['SELECT 1']);
    await expect(
      postgresCheck({
        query: async () => {
          throw new Error('Connection terminated');
        },
      })(new AbortController().signal),
    ).rejects.toThrow('Connection terminated');
  });
});
