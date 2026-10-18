import { describe, expect, it } from 'vitest';
import { createCircuitBreaker } from '../../../src/adapters/system-b/circuit-breaker.js';

function setup() {
  let t = 0;
  const changes: string[] = [];
  const breaker = createCircuitBreaker({
    threshold: 5,
    openMs: 30_000,
    now: () => t,
    onChange: (from, to) => changes.push(`${from}→${to}`),
  });
  return { breaker, changes, advance: (ms: number) => (t += ms) };
}

const fail = (b: ReturnType<typeof setup>['breaker'], n: number) => {
  for (let i = 0; i < n; i++) {
    expect(b.tryAcquire()).toBe(true);
    b.onFailure();
  }
};

describe('circuit breaker (5 falhas → aberto 30 s)', () => {
  it('abre na 5ª falha seguida e recusa sem chamar o B', () => {
    const { breaker, changes } = setup();
    fail(breaker, 4);
    expect(breaker.state()).toBe('closed');
    fail(breaker, 1);
    expect(breaker.state()).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
    expect(breaker.remainingOpenMs()).toBe(30_000);
    expect(changes).toEqual(['closed→open']);
  });

  it('um sucesso no meio zera a contagem', () => {
    const { breaker } = setup();
    fail(breaker, 4);
    breaker.onSuccess();
    fail(breaker, 4);
    expect(breaker.state()).toBe('closed');
  });

  it('depois de 30 s deixa passar uma única requisição de teste; sucesso fecha', () => {
    const { breaker, advance, changes } = setup();
    fail(breaker, 5);
    advance(29_999);
    expect(breaker.tryAcquire()).toBe(false);
    advance(1);
    expect(breaker.state()).toBe('half_open');
    expect(breaker.remainingOpenMs()).toBe(0);
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(false); // a segunda espera o resultado da primeira
    breaker.onSuccess();
    expect(breaker.state()).toBe('closed');
    expect(breaker.tryAcquire()).toBe(true);
    expect(changes).toEqual(['closed→open', 'half_open→closed']);
  });

  it('falha na meia-abertura reabre por mais 30 s, sem precisar de outras 5', () => {
    const { breaker, advance } = setup();
    fail(breaker, 5);
    advance(30_000);
    expect(breaker.tryAcquire()).toBe(true);
    breaker.onFailure();
    expect(breaker.state()).toBe('open');
    expect(breaker.remainingOpenMs()).toBe(30_000);
  });
});
