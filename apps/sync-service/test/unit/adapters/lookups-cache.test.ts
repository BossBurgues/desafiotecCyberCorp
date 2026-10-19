import { describe, expect, it } from 'vitest';
import { cachedLookups } from '../../../src/adapters/system-a/lookups-cache.js';
import type { Lookups } from '../../../src/domain/types.js';

describe('cache dos catálogos do A', () => {
  const table = (n: number): Lookups => ({ users: new Map([[1, `v${n}`]]) });

  it('reaproveita dentro do prazo, recarrega depois e compartilha a carga em andamento', async () => {
    let loads = 0;
    let clock = 0;
    const get = cachedLookups(async () => table(++loads), 1000, () => clock);
    const [x, y] = await Promise.all([get(), get()]);
    expect(loads).toBe(1);
    expect(x).toBe(y);
    clock = 999;
    await get();
    expect(loads).toBe(1);
    clock = 1000;
    expect(((await get()).users as Map<number, string>).get(1)).toBe('v2');
  });

  it('falha não fica no cache: a próxima chamada tenta de novo', async () => {
    let calls = 0;
    const get = cachedLookups(async () => {
      calls++;
      if (calls === 1) throw new Error('A fora');
      return table(calls);
    }, 1000);
    await expect(get()).rejects.toThrow('A fora');
    expect(((await get()).users as Map<number, string>).get(1)).toBe('v2');
  });
});
