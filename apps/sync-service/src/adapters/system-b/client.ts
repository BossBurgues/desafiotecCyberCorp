import type { Logger } from 'pino';
import type { z } from 'zod';
import type { RecordInput } from '../../domain/types.js';
import { createCircuitBreaker, type BreakerState, type CircuitBreaker } from './circuit-breaker.js';
import { BError, reasonForStatus } from './errors.js';
import { apiErrorSchema, describeIssues, recordPageSchema, recordSchema } from './schema.js';

export type BRecordResponse = z.infer<typeof recordSchema>;
export type BRecordPage = z.infer<typeof recordPageSchema>;

export interface CallOptions {
  correlationId?: string;
}

export interface SystemBClient {
  createRecord(input: RecordInput, options?: CallOptions): Promise<BRecordResponse>;
  /** null = 404 (excluído ou nunca gravado, ex.: ack sem gravar). Quem decide o que isso significa é o caso de uso. */
  getRecord(id: string, options?: CallOptions): Promise<BRecordResponse | null>;
  updateRecord(id: string, input: RecordInput, options?: CallOptions & { ifMatch?: string }): Promise<BRecordResponse>;
  listRecords(page: number, pageSize: number, options?: CallOptions): Promise<BRecordPage>;
  breakerState(): BreakerState;
}

export interface SystemBClientOptions {
  baseUrl: string;
  timeoutMs: number;
  breakerThreshold: number;
  breakerOpenMs: number;
  logger: Logger;
  /** Espera padrão depois de um 429 sem Retry-After legível. */
  rateLimitDefaultMs?: number;
  /** Teto da espera pedida pelo B: um Retry-After absurdo não congela o sync. */
  rateLimitMaxMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const API_PREFIX = '/api/v2';

/** Retry-After em segundos ou data HTTP; null se ausente ou ilegível. */
export function parseRetryAfter(raw: string | null, now: number): number | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const at = Date.parse(s);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * Cliente do B (S3.5). Trata o B como hostil: timeout por requisição, disjuntor, desaceleração em 429 e validação do
 * corpo de toda resposta 2xx contra o contrato. Toda falha sai como BError com classe (transitório/permanente) e,
 * em escrita, se o resultado é ambíguo (o B pode ter gravado).
 */
export function createSystemBClient(options: SystemBClientOptions): SystemBClient {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rateLimitDefaultMs = options.rateLimitDefaultMs ?? 1_000;
  const rateLimitMaxMs = options.rateLimitMaxMs ?? 60_000;
  const log = options.logger.child({ component: 'system-b-client' });

  const breaker: CircuitBreaker = createCircuitBreaker({
    threshold: options.breakerThreshold,
    openMs: options.breakerOpenMs,
    now,
    onChange: (from, to) =>
      (to === 'open' ? log.warn.bind(log) : log.info.bind(log))({ from, to }, `disjuntor do B: ${from} → ${to}`),
  });

  // Desaceleração: depois de um 429, ninguém chama o B antes deste instante
  let slowUntil = 0;

  async function call<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    schema: z.ZodType<T>,
    opts: { body?: unknown; headers?: Record<string, string>; correlationId?: string | undefined; allow404?: boolean },
  ): Promise<T | null> {
    const write = method !== 'GET';
    const op = `${method} ${API_PREFIX}${path}`;

    if (!breaker.tryAcquire()) {
      throw new BError('circuit_open', `${op}: disjuntor aberto, B indisponível`, {
        write,
        retryAfterMs: breaker.remainingOpenMs(),
      });
    }

    const wait = slowUntil - now();
    if (wait > 0) await sleep(wait);

    const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.correlationId) headers['x-correlation-id'] = opts.correlationId;

    const started = now();
    let res: Response;
    let text: string;
    try {
      res = await doFetch(`${options.baseUrl}${API_PREFIX}${path}`, {
        method,
        headers,
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      breaker.onFailure();
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw timedOut
        ? new BError('timeout', `${op}: sem resposta em ${options.timeoutMs} ms`, { write, cause: err })
        : new BError('network', `${op}: falha de rede (${err instanceof Error ? err.message : String(err)})`, {
            write,
            cause: err,
          });
    }
    const latencyMs = now() - started;

    if (res.status === 429) {
      // O B está de pé e pedindo calma: não conta para o disjuntor, mas freia todas as chamadas seguintes
      breaker.onSuccess();
      const retryAfterMs = Math.min(parseRetryAfter(res.headers.get('retry-after'), now()) ?? rateLimitDefaultMs, rateLimitMaxMs);
      slowUntil = Math.max(slowUntil, now() + retryAfterMs);
      log.warn({ op, retryAfterMs }, 'B respondeu 429: desacelerando');
      throw new BError('rate_limited', `${op}: 429 (aguardar ${retryAfterMs} ms)`, { write, status: 429, retryAfterMs });
    }

    if (res.status < 200 || res.status >= 300) {
      const reason = reasonForStatus(res.status);
      if (reason === 'server_error') breaker.onFailure();
      else breaker.onSuccess(); // 4xx: o B respondeu, só recusou
      if (reason === 'not_found' && opts.allow404) return null;
      const detail = apiErrorSchema.safeParse(safeJson(text));
      throw new BError(reason, `${op}: ${res.status}${detail.success ? ` ${detail.data.error}: ${detail.data.message}` : ''}`, {
        write,
        status: res.status,
      });
    }

    const json = safeJson(text);
    if (json === INVALID) {
      breaker.onFailure();
      throw new BError('invalid_body', `${op}: ${res.status} com corpo que não é JSON`, { write, status: res.status });
    }

    const parsed = schema.safeParse(json);
    if (parsed.success) {
      breaker.onSuccess();
      log.debug({ op, status: res.status, latencyMs }, 'chamada ao B');
      return parsed.data;
    }

    // 2xx fora do contrato: ou é o "200 com erro" (instabilidade, transitório) ou o formato mudou (drift, permanente)
    const errorBody = apiErrorSchema.safeParse(json);
    if (errorBody.success) {
      breaker.onFailure();
      throw new BError('error_body', `${op}: ${res.status} com corpo de erro ${errorBody.data.error}: ${errorBody.data.message}`, {
        write,
        status: res.status,
      });
    }
    breaker.onSuccess();
    const issues = describeIssues(parsed.error);
    log.error({ op, status: res.status, issues }, 'resposta do B fora do contrato (drift de formato)');
    throw new BError('schema_drift', `${op}: resposta fora do contrato (${issues})`, { write, status: res.status });
  }

  return {
    async createRecord(input, o = {}) {
      return (await call('POST', '/records', recordSchema, { body: input, correlationId: o.correlationId }))!;
    },
    getRecord(id, o = {}) {
      return call('GET', `/records/${encodeURIComponent(id)}`, recordSchema, {
        correlationId: o.correlationId,
        allow404: true,
      });
    },
    async updateRecord(id, input, o = {}) {
      return (await call('PUT', `/records/${encodeURIComponent(id)}`, recordSchema, {
        body: input,
        correlationId: o.correlationId,
        ...(o.ifMatch ? { headers: { 'if-match': o.ifMatch } } : {}),
      }))!;
    },
    async listRecords(page, pageSize, o = {}) {
      return (await call('GET', `/records?page=${page}&pageSize=${pageSize}`, recordPageSchema, {
        correlationId: o.correlationId,
      }))!;
    },
    breakerState: () => breaker.state(),
  };
}

const INVALID = Symbol('invalid-json');

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return INVALID;
  }
}
