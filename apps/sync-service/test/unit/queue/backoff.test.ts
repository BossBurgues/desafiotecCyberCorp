import { describe, expect, it } from 'vitest';
import { backoffDelayMs, DEFAULT_RETRY_POLICY } from '../../../src/infra/queue/backoff.js';

describe('backoff 1 s·2ⁿ + jitter, teto de 5 min', () => {
  it('dobra a cada falha, começando em 1 s', () => {
    const noJitter = () => 0;
    expect([1, 2, 3, 4, 5].map((n) => backoffDelayMs(n, DEFAULT_RETRY_POLICY, noJitter))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000,
    ]);
  });

  it('jitter soma até uma base', () => {
    expect(backoffDelayMs(1, DEFAULT_RETRY_POLICY, () => 0.5)).toBe(1_500);
    expect(backoffDelayMs(3, DEFAULT_RETRY_POLICY, () => 0.999)).toBe(4_999);
  });

  it('nunca passa de 5 min, nem com muitas falhas', () => {
    expect(backoffDelayMs(10, DEFAULT_RETRY_POLICY, () => 0.99)).toBe(300_000);
    expect(backoffDelayMs(5_000, DEFAULT_RETRY_POLICY, () => 0.99)).toBe(300_000);
    expect(backoffDelayMs(0, DEFAULT_RETRY_POLICY, () => 0)).toBe(1_000);
  });
});
