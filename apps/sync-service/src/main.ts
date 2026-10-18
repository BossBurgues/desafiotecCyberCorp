import pg from 'pg';
import { ConfigError, loadConfig } from './config.js';
import { migrate } from './infra/db/migrate.js';
import { buildServer } from './infra/http/server.js';
import { createReadiness, httpHealthCheck, postgresCheck } from './infra/http/readiness.js';
import { createLogger } from './infra/logger.js';
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

  const worker = startWorkerLoop({
    isReady: readiness.isReady,
    // A fila (infra/queue: claim com SKIP LOCKED, lease, backoff, DLQ) está pronta; o tick passa a ser
    // drain({ pool, processor: processJob, ... }) quando o processJob entrar na S3.6 (#34)
    tick: async () => {},
    intervalMs: config.WORKER_POLL_INTERVAL_MS,
    logger,
  });

  const app = buildServer({ logger, readiness });
  await app.listen({ host: config.HOST, port: config.PORT });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'desligando');
    clearInterval(readinessTimer);
    await app.close();
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
