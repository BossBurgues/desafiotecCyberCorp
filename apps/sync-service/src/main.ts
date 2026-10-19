import pg from 'pg';
import { createSystemAClient } from './adapters/system-a/client.js';
import { createSystemBClient } from './adapters/system-b/client.js';
import { startPoller } from './application/poller.js';
import { createProcessJob } from './application/process-job.js';
import { ConfigError, loadConfig } from './config.js';
import { migrate } from './infra/db/migrate.js';
import { buildServer } from './infra/http/server.js';
import { createReadiness, httpHealthCheck, postgresCheck } from './infra/http/readiness.js';
import { createLogger } from './infra/logger.js';
import { dashboardPlugin } from './infra/http/dashboard.js';
import { webhookPlugin } from './infra/http/webhook.js';
import { drain } from './infra/queue/runner.js';
import { startWorkerLoop } from './infra/queue/worker-loop.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config.LOG_LEVEL);
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
  // Erro num cliente ocioso (ex.: Postgres reiniciou) não pode derrubar o processo: o /ready mostra e o worker pausa
  pool.on('error', (err) => logger.error({ err }, 'erro em conexão ociosa do Postgres'));

  await migrate(pool, logger);

  const readiness = createReadiness({
    timeoutMs: config.READY_CHECK_TIMEOUT_MS,
    checks: {
      postgres: postgresCheck(pool),
      system_a: httpHealthCheck(config.A_BASE_URL),
      system_b: httpHealthCheck(config.B_BASE_URL),
    },
  });
  await readiness.refresh();
  const readinessTimer = setInterval(() => void readiness.refresh(), config.READY_CHECK_INTERVAL_MS);

  const a = createSystemAClient({
    baseUrl: config.A_BASE_URL,
    appToken: config.A_APP_TOKEN,
    userToken: config.A_SYNC_BOT_TOKEN,
    timeoutMs: config.A_TIMEOUT_MS,
    logger,
  });
  const b = createSystemBClient({
    baseUrl: config.B_BASE_URL,
    timeoutMs: config.B_TIMEOUT_MS,
    breakerThreshold: config.B_BREAKER_THRESHOLD,
    breakerOpenMs: config.B_BREAKER_OPEN_MS,
    logger,
  });
  const processor = createProcessJob({
    pool,
    a,
    b,
    logger,
    timeZone: config.A_TIMEZONE,
    markerField: config.B_MARKER_FIELD,
    uncertainScans: config.CREATE_UNCERTAIN_SCANS,
    listPageSize: config.B_LIST_PAGE_SIZE,
    verifyAfterWrite: config.VERIFY_AFTER_WRITE,
  });
  const policy = {
    baseMs: config.QUEUE_BACKOFF_BASE_MS,
    maxDelayMs: config.QUEUE_BACKOFF_MAX_MS,
    transientMaxAgeMs: config.QUEUE_TRANSIENT_MAX_AGE_MS,
    permanentMaxAttempts: config.QUEUE_PERMANENT_MAX_ATTEMPTS,
  };

  const worker = startWorkerLoop({
    isReady: readiness.isReady,
    tick: async () => {
      await drain({ pool, processor, logger, leaseMs: config.QUEUE_LEASE_MS, policy, maxJobs: config.WORKER_MAX_JOBS_PER_TICK });
    },
    intervalMs: config.WORKER_POLL_INTERVAL_MS,
    logger,
  });

  const poller = startPoller({
    pool,
    a,
    logger,
    timeZone: config.A_TIMEZONE,
    overlapMs: config.POLL_OVERLAP_MS,
    pageSize: config.POLL_PAGE_SIZE,
    intervalMs: config.POLL_INTERVAL_MS,
    isReady: readiness.isReady,
  });

  const plugins = [webhookPlugin({ pool, secret: config.HMAC_SECRET, windowMs: config.WEBHOOK_REPLAY_WINDOW_MS })];
  if (config.DASHBOARD_USER && config.DASHBOARD_PASSWORD) {
    plugins.push(
      dashboardPlugin({
        pool,
        breakerState: () => b.breakerState(),
        bAdmin: config.B_ADMIN_TOKEN ? { baseUrl: config.B_BASE_URL, token: config.B_ADMIN_TOKEN } : undefined,
        controlsEnabled: config.DASHBOARD_CONTROLS,
        auth: { user: config.DASHBOARD_USER, password: config.DASHBOARD_PASSWORD },
      }),
    );
  } else {
    // Falha segura: esquecer a senha nunca deixa o painel (e o caos) aberto na internet
    logger.warn('DASHBOARD_USER/DASHBOARD_PASSWORD ausentes: dashboard e /metrics não foram registrados');
  }
  const app = buildServer({ logger, readiness, plugins });
  await app.listen({ host: config.HOST, port: config.PORT });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'desligando');
    clearInterval(readinessTimer);
    await app.close();
    await poller.stop();
    await worker.stop();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('sync-service não subiu:', err instanceof Error ? err.message : err);
  process.exit(1);
});
