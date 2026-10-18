import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createSystemBClient, parseRetryAfter } from '../../../src/adapters/system-b/client.js';
import { BError } from '../../../src/adapters/system-b/errors.js';
import { recordSchema } from '../../../src/adapters/system-b/schema.js';
import type { RecordInput } from '../../../src/domain/types.js';
import { memoryLogger } from '../../helpers.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const contract = parseYaml(readFileSync(resolve(REPO_ROOT, 'contracts/system-b.openapi.yaml'), 'utf8')) as {
  components: { schemas: { Record: { example: Record<string, unknown> } } };
};
const RECORD = contract.components.schemas.Record.example;

const INPUT: RecordInput = {
  title: 'Impressora',
  description: 'Parou.\n\n⟦s:glpi-42⟧',
  state: 'IN_PROGRESS',
  severity: 'HIGH',
};

type Reply = { status: number; body?: unknown; raw?: string; headers?: Record<string, string> };

/** Cliente com fetch falso: cada chamada consome a próxima resposta da fila e fica registrada. */
function setup(replies: (Reply | Error)[], extra: { now?: () => number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  const queue = [...replies];
  let t = 1_000_000;
  const now = extra.now ?? (() => t);
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error('sem resposta programada');
    if (next instanceof Error) throw next;
    const text = next.raw ?? (next.body === undefined ? '' : JSON.stringify(next.body));
    return new Response(next.status === 204 ? null : text, { status: next.status, headers: next.headers ?? {} });
  }) as unknown as typeof fetch;
  const { logger, lines } = memoryLogger('debug');
  const client = createSystemBClient({
    baseUrl: 'http://b.test',
    timeoutMs: 5_000,
    breakerThreshold: 5,
    breakerOpenMs: 30_000,
    logger,
    fetch: fakeFetch,
    now,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  });
  return { client, calls, sleeps, lines, advance: (ms: number) => (t += ms) };
}

async function failure(p: Promise<unknown>): Promise<BError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(BError);
    return err as BError;
  }
  throw new Error('esperava BError');
}

describe('esquema da resposta do B', () => {
  it('o exemplo do contrato passa', () => {
    expect(recordSchema.safeParse(RECORD).success).toBe(true);
  });

  it('campo renomeado (drift do admin do B: title → summary) não passa', () => {
    const { title, ...rest } = RECORD;
    expect(recordSchema.safeParse({ ...rest, summary: title }).success).toBe(false);
  });
});

describe('cliente do B: caminho feliz', () => {
  it('create manda o corpo em JSON e devolve o registro validado', async () => {
    const { client, calls } = setup([{ status: 201, body: RECORD }]);
    const rec = await client.createRecord(INPUT, { correlationId: 'corr-1' });
    expect(rec.id).toBe('B-981');
    expect(calls[0]!.url).toBe('http://b.test/api/v2/records');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(INPUT);
    expect((calls[0]!.init.headers as Record<string, string>)['x-correlation-id']).toBe('corr-1');
  });

  it('get devolve null no 404 (excluído ou ack sem gravar) sem contar como falha', async () => {
    const { client } = setup([{ status: 404, body: { error: 'NOT_FOUND', message: 'x' } }]);
    expect(await client.getRecord('B-1')).toBeNull();
    expect(client.breakerState()).toBe('closed');
  });

  it('update manda If-Match quando houver e escapa o ID na URL', async () => {
    const { client, calls } = setup([{ status: 200, body: RECORD }]);
    await client.updateRecord('B/1', INPUT, { ifMatch: '"v3"' });
    expect(calls[0]!.url).toBe('http://b.test/api/v2/records/B%2F1');
    expect((calls[0]!.init.headers as Record<string, string>)['if-match']).toBe('"v3"');
  });

  it('list valida a página e cada item', async () => {
    const { client, calls } = setup([{ status: 200, body: { items: [RECORD], page: 2, pageSize: 10, total: 11 } }]);
    const page = await client.listRecords(2, 10);
    expect(page.items).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://b.test/api/v2/records?page=2&pageSize=10');
  });
});

describe('cliente do B: "B fora" × "B recusou"', () => {
  it.each([
    [{ status: 500, body: { error: 'CHAOS_SIMULATED_ERROR', message: 'x' } }, 'server_error', true],
    [{ status: 503 }, 'server_error', true],
    [{ status: 200, body: { error: 'CHAOS_SIMULATED_ERROR', message: 'falha com 200' } }, 'error_body', true],
    [{ status: 201, raw: '<html>gateway</html>' }, 'invalid_body', true],
  ])('%o → transitório (%s), ambíguo no create', async (reply, reason, ambiguous) => {
    const { client } = setup([reply]);
    const err = await failure(client.createRecord(INPUT));
    expect(err).toMatchObject({ reason, errorClass: 'transient', ambiguous });
  });

  it.each([
    [400, 'rejected'],
    [422, 'rejected'],
    [401, 'rejected'],
  ])('%i → permanente (%s), nunca ambíguo', async (status, reason) => {
    const { client } = setup([{ status, body: { error: 'VALIDATION_ERROR', message: 'title vazio' } }]);
    const err = await failure(client.createRecord(INPUT));
    expect(err).toMatchObject({ reason, errorClass: 'permanent', ambiguous: false, status });
    expect(err.message).toContain('VALIDATION_ERROR: title vazio');
  });

  it('404 no update é permanente (o registro sumiu: quem decide é o fluxo de exclusão)', async () => {
    const { client } = setup([{ status: 404 }]);
    expect(await failure(client.updateRecord('B-1', INPUT))).toMatchObject({ reason: 'not_found', errorClass: 'permanent' });
  });

  it('412 com If-Match é transitório: reler e tentar de novo', async () => {
    const { client } = setup([{ status: 412 }]);
    expect(await failure(client.updateRecord('B-1', INPUT, { ifMatch: '"1"' }))).toMatchObject({
      reason: 'precondition_failed',
      errorClass: 'transient',
    });
  });

  it('200 com drift de formato é permanente e não abre o disjuntor', async () => {
    const { title, ...rest } = RECORD;
    const drifted = { ...rest, summary: title };
    const { client, lines } = setup(Array.from({ length: 6 }, () => ({ status: 200, body: drifted })));
    for (let i = 0; i < 6; i++) {
      expect(await failure(client.getRecord('B-981'))).toMatchObject({ reason: 'schema_drift', errorClass: 'permanent' });
    }
    expect(client.breakerState()).toBe('closed');
    const log = lines.find((l) => l.msg === 'resposta do B fora do contrato (drift de formato)');
    expect(String(log?.issues)).toMatch(/title|summary/);
  });

  it('erro de rede é transitório; leitura nunca é ambígua', async () => {
    const { client } = setup([new TypeError('fetch failed')]);
    expect(await failure(client.getRecord('B-1'))).toMatchObject({ reason: 'network', ambiguous: false });
  });
});

describe('cliente do B: timeout de 5 s (servidor de verdade)', () => {
  it('desiste depois do timeout e classifica como timeout ambíguo no create', async () => {
    const server = createServer(() => {
      /* nunca responde, como o timeout do caos */
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const { logger } = memoryLogger();
    const client = createSystemBClient({
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 150,
      breakerThreshold: 5,
      breakerOpenMs: 30_000,
      logger,
    });
    try {
      const started = Date.now();
      const err = await failure(client.createRecord(INPUT));
      expect(err).toMatchObject({ reason: 'timeout', errorClass: 'transient', ambiguous: true });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('cliente do B: circuit breaker', () => {
  it('5 falhas transitórias seguidas abrem; a 6ª chamada nem sai e diz quanto esperar', async () => {
    const { client, calls, advance } = setup([
      ...Array.from({ length: 5 }, () => ({ status: 503 })),
      { status: 200, body: RECORD },
    ]);
    for (let i = 0; i < 5; i++) await failure(client.getRecord('B-1'));
    expect(client.breakerState()).toBe('open');

    const blocked = await failure(client.getRecord('B-1'));
    expect(blocked).toMatchObject({ reason: 'circuit_open', errorClass: 'transient', retryAfterMs: 30_000 });
    expect(calls).toHaveLength(5);

    advance(30_000);
    expect(await client.getRecord('B-1')).toMatchObject({ id: 'B-981' });
    expect(client.breakerState()).toBe('closed');
  });

  it('4xx não conta como B fora', async () => {
    const { client } = setup(Array.from({ length: 6 }, () => ({ status: 422 })));
    for (let i = 0; i < 6; i++) await failure(client.createRecord(INPUT));
    expect(client.breakerState()).toBe('closed');
  });
});

describe('cliente do B: desacelera em 429', () => {
  it('respeita o Retry-After antes da próxima chamada e não abre o disjuntor', async () => {
    const { client, sleeps } = setup([
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 200, body: RECORD },
    ]);
    const err = await failure(client.getRecord('B-1'));
    expect(err).toMatchObject({ reason: 'rate_limited', errorClass: 'transient', retryAfterMs: 2_000 });
    await client.getRecord('B-1');
    expect(sleeps).toEqual([2_000]);
    expect(client.breakerState()).toBe('closed');
  });

  it('sem Retry-After espera 1 s; Retry-After absurdo é limitado a 60 s', async () => {
    const a = setup([{ status: 429 }]);
    expect((await failure(a.client.getRecord('B-1'))).retryAfterMs).toBe(1_000);
    const b = setup([{ status: 429, headers: { 'retry-after': '86400' } }]);
    expect((await failure(b.client.getRecord('B-1'))).retryAfterMs).toBe(60_000);
  });

  it('parseRetryAfter aceita segundos e data HTTP', () => {
    const now = Date.parse('2026-10-18T12:00:00Z');
    expect(parseRetryAfter('3', now)).toBe(3_000);
    expect(parseRetryAfter('Sun, 18 Oct 2026 12:00:05 GMT', now)).toBe(5_000);
    expect(parseRetryAfter('Sun, 18 Oct 2026 11:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('amanhã', now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});
