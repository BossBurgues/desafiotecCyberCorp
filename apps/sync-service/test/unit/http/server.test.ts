import { describe, expect, it } from 'vitest';
import { buildServer, correlationIdFrom } from '../../../src/infra/http/server.js';
import { createReadiness } from '../../../src/infra/http/readiness.js';
import { memoryLogger } from '../../helpers.js';

function app(up: { postgres: boolean }) {
  const { logger, lines } = memoryLogger();
  const readiness = createReadiness({
    timeoutMs: 100,
    checks: {
      postgres: async () => {
        if (!up.postgres) throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      },
      system_a: async () => {},
      system_b: async () => {},
    },
  });
  return { server: buildServer({ logger, readiness }), lines, readiness };
}

describe('GET /health', () => {
  it('responde 200 mesmo com dependências fora do ar (liveness)', async () => {
    const { server } = app({ postgres: false });
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /ready', () => {
  it('200 com o detalhe de cada dependência quando todas estão de pé', async () => {
    const { server } = app({ postgres: true });
    const res = await server.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ready).toBe(true);
    expect(Object.keys(body.checks).sort()).toEqual(['postgres', 'system_a', 'system_b']);
  });

  it('503 sem Postgres, dizendo qual dependência caiu (cenário H5)', async () => {
    const up = { postgres: false };
    const { server, readiness } = app(up);
    const res = await server.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.postgres).toMatchObject({ ok: false, error: expect.stringContaining('ECONNREFUSED') });
    expect(readiness.isReady()).toBe(false);

    up.postgres = true;
    expect((await server.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    expect(readiness.isReady()).toBe(true);
  });
});

describe('correlation_id', () => {
  it('reaproveita o x-correlation-id recebido, devolve no cabeçalho e grava nos logs', async () => {
    const { server, lines } = app({ postgres: true });
    const res = await server.inject({ method: 'GET', url: '/health', headers: { 'x-correlation-id': 'abc-123' } });
    expect(res.headers['x-correlation-id']).toBe('abc-123');
    const requestLogs = lines.filter((l) => l.correlation_id === 'abc-123');
    expect(requestLogs.length).toBeGreaterThanOrEqual(2); // "incoming request" e "request completed"
  });

  it('gera um UUID quando não vem cabeçalho', async () => {
    const { server } = app({ postgres: true });
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('descarta ID com quebra de linha, espaço ou longo demais (não deixa forjar linha de log)', () => {
    expect(correlationIdFrom('ok-1')).toBe('ok-1');
    expect(correlationIdFrom(['primeiro', 'segundo'])).toBe('primeiro');
    for (const bad of ['a\nb', 'com espaço', 'x'.repeat(129), '', undefined]) {
      expect(correlationIdFrom(bad)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('não loga o cabeçalho Authorization', async () => {
    const { logger, lines } = memoryLogger('trace');
    const server = buildServer({ logger, readiness: createReadiness({ checks: {}, timeoutMs: 10 }) });
    server.get('/eco', async (req) => {
      req.log.info({ req: { headers: req.headers } }, 'eco');
      return {};
    });
    await server.inject({ method: 'GET', url: '/eco', headers: { authorization: 'Bearer token-secreto' } });
    expect(JSON.stringify(lines)).not.toContain('token-secreto');
  });
});
