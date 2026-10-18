import { describe, expect, it } from 'vitest';
import { startWorkerLoop } from '../../../src/infra/queue/worker-loop.js';
import { memoryLogger } from '../../helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('startWorkerLoop', () => {
  it('não processa nada enquanto /ready falha e retoma quando volta', async () => {
    const { logger, lines } = memoryLogger();
    let ready = false;
    let ticks = 0;
    const loop = startWorkerLoop({ isReady: () => ready, tick: async () => void ticks++, intervalMs: 10, logger });

    await sleep(80);
    expect(ticks).toBe(0);
    ready = true;
    await sleep(80);
    expect(ticks).toBeGreaterThan(0);
    await loop.stop();

    const msgs = lines.map((l) => l.msg);
    // um aviso por transição, não um por tick
    expect(msgs.filter((m) => String(m).startsWith('worker pausado'))).toHaveLength(1);
    expect(msgs.filter((m) => String(m).startsWith('worker retomado'))).toHaveLength(1);
  });

  it('erro no tick é logado e o laço continua', async () => {
    const { logger, lines } = memoryLogger();
    let ticks = 0;
    const loop = startWorkerLoop({
      isReady: () => true,
      tick: async () => {
        ticks++;
        throw new Error('boom');
      },
      intervalMs: 10,
      logger,
    });
    await sleep(80);
    await loop.stop();
    expect(ticks).toBeGreaterThan(1);
    expect(lines.some((l) => l.msg === 'falha inesperada no tick do worker')).toBe(true);
  });

  it('stop espera o tick em andamento e não agenda outro', async () => {
    const { logger } = memoryLogger();
    let finished = 0;
    let started = 0;
    const loop = startWorkerLoop({
      isReady: () => true,
      tick: async () => {
        started++;
        await sleep(50);
        finished++;
      },
      intervalMs: 5,
      logger,
    });
    await sleep(20);
    await loop.stop();
    expect(finished).toBe(started);
    const after = started;
    await sleep(40);
    expect(started).toBe(after);
  });
});
