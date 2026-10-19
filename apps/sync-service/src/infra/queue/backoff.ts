export interface RetryPolicy {
  /** Base do backoff exponencial (1 s). */
  baseMs: number;
  /** Teto do atraso entre tentativas (5 min). */
  maxDelayMs: number;
  /** Erro transitório vai para a DLQ quando a primeira falha passou desta idade (24 h). */
  transientMaxAgeMs: number;
  /** Erro permanente vai para a DLQ nesta tentativa (3). */
  permanentMaxAttempts: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseMs: 1_000,
  maxDelayMs: 300_000,
  transientMaxAgeMs: 24 * 60 * 60 * 1_000,
  permanentMaxAttempts: 3,
};

/**
 * Atraso antes da tentativa seguinte: base·2ⁿ + jitter (até uma base), nunca acima do teto.
 * n começa em 0 na primeira falha (1 s, 2 s, 4 s … 5 min). O jitter espalha os jobs que falharam juntos
 * (B caiu para todo mundo) para não voltarem todos no mesmo segundo.
 */
export function backoffDelayMs(failures: number, policy: Pick<RetryPolicy, 'baseMs' | 'maxDelayMs'>, random = Math.random): number {
  const n = Math.max(0, failures - 1);
  // 2^n estoura para Infinity bem depois do teto; Math.min resolve
  const exp = policy.baseMs * 2 ** Math.min(n, 30);
  return Math.round(Math.min(policy.maxDelayMs, exp + random() * policy.baseMs));
}
