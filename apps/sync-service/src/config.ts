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
