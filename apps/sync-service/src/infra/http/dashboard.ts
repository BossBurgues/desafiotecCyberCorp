import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';
import type { Pool } from 'pg';
import type { BreakerState } from '../../adapters/system-b/circuit-breaker.js';
import { reprocessDead } from '../queue/queue.js';

export const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public');

export interface DashboardOptions {
  pool: Pool;
  breakerState: () => BreakerState;
  /** Admin do B (caos). Sem B_ADMIN_TOKEN no sync, o painel de caos fica desligado. */
  bAdmin?: { baseUrl: string; token: string; fetch?: typeof fetch } | undefined;
  /**
   * Reprocessar e mexer no caos alteram o sistema. Até o login do dashboard (S5.3, #46) eles ficam desligados por
   * padrão e só são ligados de propósito (local, E2E, demo).
   */
  controlsEnabled: boolean;
}

const STATUSES = ['pending', 'running', 'done', 'dead'] as const;
const MAPPING_STATES = ['active', 'create_uncertain', 'quarantine', 'deletion_requested', 'archived'] as const;
const BREAKER_VALUE: Record<BreakerState, number> = { closed: 0, half_open: 1, open: 2 };

export interface Summary {
  jobs: Record<(typeof STATUSES)[number], number>;
  dlq: { id: number; ticket_id: number; attempts: number; error_class: string | null; last_error: string | null; updated_at: string }[];
  mappings: Record<(typeof MAPPING_STATES)[number], number>;
  recentMappings: { a_ticket_id: number; b_record_id: string | null; state: string; updated_at: string }[];
  alerts: { id: number; kind: string; ticket_id: number | null; message: string; created_at: string }[];
  breaker: BreakerState;
  controlsEnabled: boolean;
  chaosAvailable: boolean;
}

interface Tally {
  key: string;
  n: number;
}

/** Contagem por chave, com zero para as chaves que não aparecem (o gráfico e o /metrics sempre têm todas). */
function tally<K extends string>(keys: readonly K[], rows: Tally[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, rows.find((r) => r.key === k)?.n ?? 0])) as Record<K, number>;
}

export async function loadSummary(pool: Pick<Pool, 'query'>): Promise<Omit<Summary, 'breaker' | 'controlsEnabled' | 'chaosAvailable'>> {
  const [jobs, dlq, mappings, recent, alerts] = await Promise.all([
    pool.query<Tally>(`SELECT status AS key, count(*)::int AS n FROM sync_jobs GROUP BY status`),
    pool.query(
      `SELECT id, ticket_id, attempts, error_class, last_error, updated_at FROM sync_jobs
       WHERE status = 'dead' AND reprocessed_at IS NULL ORDER BY updated_at DESC LIMIT 50`,
    ),
    pool.query<Tally>(`SELECT state AS key, count(*)::int AS n FROM ticket_mapping GROUP BY state`),
    pool.query(
      `SELECT a_ticket_id, b_record_id, state, updated_at FROM ticket_mapping ORDER BY updated_at DESC LIMIT 50`,
    ),
    pool.query(`SELECT id, kind, ticket_id, message, created_at FROM alerts_outbox ORDER BY id DESC LIMIT 20`),
  ]);
  return {
    jobs: tally(STATUSES, jobs.rows),
    mappings: tally(MAPPING_STATES, mappings.rows),
    dlq: dlq.rows.map((r) => ({ ...r, id: Number(r.id), ticket_id: Number(r.ticket_id) })),
    recentMappings: recent.rows.map((r) => ({ ...r, a_ticket_id: Number(r.a_ticket_id) })),
    alerts: alerts.rows.map((r) => ({ ...r, id: Number(r.id), ticket_id: r.ticket_id === null ? null : Number(r.ticket_id) })),
  };
}

/** Métricas no formato texto do Prometheus (sem dependência: são poucos gauges). */
export function renderMetrics(summary: Awaited<ReturnType<typeof loadSummary>>, breaker: BreakerState): string {
  const lines: string[] = [
    '# HELP sync_jobs Jobs na fila do sync por status.',
    '# TYPE sync_jobs gauge',
    ...STATUSES.map((s) => `sync_jobs{status="${s}"} ${summary.jobs[s]}`),
    '# HELP sync_dlq_pending Itens na DLQ ainda não reprocessados.',
    '# TYPE sync_dlq_pending gauge',
    `sync_dlq_pending ${summary.dlq.length}`,
    '# HELP sync_ticket_mappings Mapeamentos chamado do A ↔ registro do B por estado.',
    '# TYPE sync_ticket_mappings gauge',
    ...MAPPING_STATES.map((s) => `sync_ticket_mappings{state="${s}"} ${summary.mappings[s]}`),
    '# HELP sync_b_circuit_breaker Disjuntor do B: 0 fechado, 1 meia-abertura, 2 aberto.',
    '# TYPE sync_b_circuit_breaker gauge',
    `sync_b_circuit_breaker ${BREAKER_VALUE[breaker]}`,
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Dashboard básico (S3.10): a fila e a DLQ ao vivo, os mapeamentos, os alertas (caixa de saída simulada), o painel
 * de caos do B e /metrics. A página é estática e lê /api/dashboard/summary a cada 2 s.
 */
export function dashboardPlugin(options: DashboardOptions): FastifyPluginAsync {
  const { pool } = options;
  const bFetch = options.bAdmin?.fetch ?? fetch;

  const controlsGuard = async (_req: unknown, reply: { code(n: number): { send(b: unknown): unknown } }) => {
    if (!options.controlsEnabled) {
      return reply.code(403).send({ error: 'controls_disabled', message: 'Controles do dashboard desligados (DASHBOARD_CONTROLS=false).' });
    }
    return undefined;
  };

  const callChaos = async (method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown) => {
    const admin = options.bAdmin!;
    const res = await bFetch(`${admin.baseUrl}/admin${path}`, {
      method,
      headers: { 'x-admin-token': admin.token, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5_000),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as unknown };
  };

  return async (app) => {
    app.get('/dashboard', async (_req, reply) => {
      const html = await readFile(resolve(PUBLIC_DIR, 'dashboard.html'), 'utf8');
      return reply
        .type('text/html; charset=utf-8')
        .header('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'")
        .send(html);
    });

    app.get('/api/dashboard/summary', async (): Promise<Summary> => ({
      ...(await loadSummary(pool)),
      breaker: options.breakerState(),
      controlsEnabled: options.controlsEnabled,
      chaosAvailable: Boolean(options.bAdmin),
    }));

    app.get('/metrics', async (_req, reply) => {
      const summary = await loadSummary(pool);
      return reply.type('text/plain; version=0.0.4').send(renderMetrics(summary, options.breakerState()));
    });

    app.post<{ Params: { id: string } }>('/api/dashboard/dlq/:id/reprocess', { preHandler: controlsGuard }, async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) return reply.code(400).send({ error: 'invalid_id', message: 'ID inválido.' });
      const res = await reprocessDead(pool, id);
      if (!res) return reply.code(404).send({ error: 'not_found', message: 'Item não está na DLQ (ou já foi reprocessado).' });
      req.log.info({ dead_job_id: id, job_id: res.jobId }, 'DLQ reprocessada pelo dashboard');
      return { jobId: res.jobId };
    });

    app.get('/api/dashboard/chaos', async (_req, reply) => {
      if (!options.bAdmin) return reply.code(503).send({ error: 'chaos_unavailable', message: 'B_ADMIN_TOKEN não configurado no sync.' });
      const r = await callChaos('GET', '/chaos');
      return reply.code(r.status).send(r.body);
    });

    app.put('/api/dashboard/chaos', { preHandler: controlsGuard }, async (req, reply) => {
      if (!options.bAdmin) return reply.code(503).send({ error: 'chaos_unavailable', message: 'B_ADMIN_TOKEN não configurado no sync.' });
      const r = await callChaos('PUT', '/chaos', req.body ?? {});
      req.log.warn({ status: r.status }, 'caos do B alterado pelo dashboard');
      return reply.code(r.status).send(r.body);
    });

    app.post('/api/dashboard/chaos/reset', { preHandler: controlsGuard }, async (req, reply) => {
      if (!options.bAdmin) return reply.code(503).send({ error: 'chaos_unavailable', message: 'B_ADMIN_TOKEN não configurado no sync.' });
      const r = await callChaos('POST', '/chaos/reset');
      req.log.warn({ status: r.status }, 'caos do B desligado pelo dashboard');
      return reply.code(r.status).send(r.body);
    });
  };
}
