import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65535);
const ms = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const httpUrl = z
  .url({ protocol: /^https?$/ })
  .transform((u) => u.replace(/\/+$/, ''));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: port.default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  A_BASE_URL: httpUrl,
  B_BASE_URL: httpUrl,
  READY_CHECK_TIMEOUT_MS: ms(100, 30_000).default(2_000),
  READY_CHECK_INTERVAL_MS: ms(500, 300_000).default(5_000),
  WORKER_POLL_INTERVAL_MS: ms(50, 60_000).default(1_000),
  // Adapter do B (S3.5, ADR-008)
  B_TIMEOUT_MS: ms(100, 60_000).default(5_000),
  B_BREAKER_THRESHOLD: z.coerce.number().int().min(1).max(100).default(5),
  B_BREAKER_OPEN_MS: ms(1_000, 600_000).default(30_000),
  // Fila (S3.3, ADR-002 e ADR-008)
  QUEUE_LEASE_MS: ms(1_000, 3_600_000).default(60_000),
  QUEUE_BACKOFF_BASE_MS: ms(10, 60_000).default(1_000),
  QUEUE_BACKOFF_MAX_MS: ms(1_000, 3_600_000).default(300_000),
  QUEUE_TRANSIENT_MAX_AGE_MS: ms(60_000, 7 * 86_400_000).default(86_400_000),
  QUEUE_PERMANENT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(3),
  WORKER_MAX_JOBS_PER_TICK: z.coerce.number().int().min(1).max(1_000).default(20),
  // Adapter do A (S3.6): o sync entra como sync-bot (só lê e escreve notas, ADR-009)
  A_APP_TOKEN: z.string().min(1),
  A_SYNC_BOT_TOKEN: z.string().min(1),
  A_TIMEZONE: z.string().min(1).default('America/Sao_Paulo'),
  A_TIMEOUT_MS: ms(100, 60_000).default(5_000),
  // processJob (S3.6, ADR-004): onde vai o marcador e quantas varreduras sem achá-lo antes de recriar
  B_MARKER_FIELD: z.enum(['description', 'title']).default('description'),
  CREATE_UNCERTAIN_SCANS: z.coerce.number().int().min(1).max(20).default(2),
  B_LIST_PAGE_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  // Entrada (S3.4): webhook com HMAC e poller com sobreposição
  HMAC_SECRET: z.string().min(16),
  WEBHOOK_REPLAY_WINDOW_MS: ms(10_000, 3_600_000).default(300_000),
  POLL_INTERVAL_MS: ms(500, 3_600_000).default(10_000),
  POLL_OVERLAP_MS: ms(0, 3_600_000).default(120_000),
  POLL_PAGE_SIZE: z.coerce.number().int().min(1).max(500).default(100),
});

export type Config = z.infer<typeof schema>;

export class ConfigError extends Error {
  public readonly problems: string[];

  constructor(problems: string[]) {
    super(`Configuração inválida do sync-service:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * Valida o ambiente inteiro de uma vez e falha rápido: o serviço não sobe com configuração parcial.
 * A mensagem lista só nomes e motivos, nunca os valores (DATABASE_URL carrega senha).
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = schema.safeParse(env);
  if (parsed.success) return parsed.data;
  throw new ConfigError(
    parsed.error.issues.map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`),
  );
}
