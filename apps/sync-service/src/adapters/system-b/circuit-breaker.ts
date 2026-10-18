export type BreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreaker {
  /** Pode mandar uma requisição agora? Na meia-abertura, só uma de teste por vez. */
  tryAcquire(): boolean;
  onSuccess(): void;
  onFailure(): void;
  state(): BreakerState;
  /** Quanto falta para a meia-abertura (0 se não está aberto). */
  remainingOpenMs(): number;
}

/**
 * Disjuntor do B (ADR-008): abre depois de `threshold` falhas seguidas, fica aberto por `openMs` e então deixa passar
 * uma requisição de teste. Sucesso fecha; falha reabre por mais `openMs`. Enquanto aberto, os jobs esperam sem gastar
 * tentativas e o B degradado não é martelado.
 */
export function createCircuitBreaker(options: {
  threshold: number;
  openMs: number;
  now?: () => number;
  onChange?: (from: BreakerState, to: BreakerState) => void;
}): CircuitBreaker {
  const now = options.now ?? Date.now;
  let failures = 0;
  let openedAt: number | null = null;
  let probing = false;

  const current = (): BreakerState => {
    if (openedAt === null) return 'closed';
    return now() - openedAt >= options.openMs ? 'half_open' : 'open';
  };

  const transition = (from: BreakerState, to: BreakerState) => {
    if (from !== to) options.onChange?.(from, to);
  };

  return {
    tryAcquire() {
      const s = current();
      if (s === 'closed') return true;
      if (s === 'open' || probing) return false;
      probing = true;
      return true;
    },
    onSuccess() {
      const from = current();
      failures = 0;
      openedAt = null;
      probing = false;
      transition(from, 'closed');
    },
    onFailure() {
      const from = current();
      probing = false;
      failures++;
      if (from === 'half_open' || failures >= options.threshold) {
        openedAt = now();
        transition(from, 'open');
      }
    },
    state: current,
    remainingOpenMs() {
      return openedAt === null ? 0 : Math.max(0, options.openMs - (now() - openedAt));
    },
  };
}
