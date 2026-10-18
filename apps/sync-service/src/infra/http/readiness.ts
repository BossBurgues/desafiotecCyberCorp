/** Uma dependência do sync: resolve se está de pé, rejeita se não está. */
export type Check = (signal: AbortSignal) => Promise<void>;

export interface CheckResult {
  ok: boolean;
  latency_ms: number;
  error?: string;
}

export interface ReadinessReport {
  ready: boolean;
  checked_at: string;
  checks: Record<string, CheckResult>;
}

export interface Readiness {
  /** Roda todas as checagens agora (em paralelo) e guarda o resultado. */
  refresh(): Promise<ReadinessReport>;
  /** Último resultado conhecido; antes da primeira checagem, não está pronto. */
  isReady(): boolean;
  last(): ReadinessReport | null;
}

async function runCheck(check: Check, timeoutMs: number, now: () => number): Promise<CheckResult> {
  const started = now();
  const elapsed = () => Math.round(now() - started);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Rejeita antes de abortar: o abort pode fazer a checagem resolver e ganhar a corrida
          reject(new Error(`sem resposta em ${timeoutMs} ms`));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
    return { ok: true, latency_ms: elapsed() };
  } catch (err) {
    return { ok: false, latency_ms: elapsed(), error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export function createReadiness(options: {
  checks: Record<string, Check>;
  timeoutMs: number;
  now?: () => number;
}): Readiness {
  const now = options.now ?? (() => performance.now());
  let report: ReadinessReport | null = null;

  return {
    async refresh() {
      const entries = await Promise.all(
        Object.entries(options.checks).map(
          async ([name, check]) => [name, await runCheck(check, options.timeoutMs, now)] as const,
        ),
      );
      const checks = Object.fromEntries(entries);
      report = {
        ready: entries.every(([, r]) => r.ok),
        checked_at: new Date().toISOString(),
        checks,
      };
      return report;
    },
    isReady: () => report?.ready ?? false,
    last: () => report,
  };
}

/** Checagem HTTP: qualquer 2xx em GET <baseUrl>/health. */
export function httpHealthCheck(baseUrl: string): Check {
  return async (signal) => {
    const res = await fetch(`${baseUrl}/health`, { signal });
    if (!res.ok) throw new Error(`GET /health respondeu ${res.status}`);
  };
}

/** Checagem do Postgres: um SELECT 1 pelo pool. */
export function postgresCheck(pool: { query(sql: string): Promise<unknown> }): Check {
  return async () => {
    await pool.query('SELECT 1');
  };
}
