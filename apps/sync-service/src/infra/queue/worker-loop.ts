import type { Logger } from 'pino';

export interface WorkerLoop {
  /** Para de agendar e espera o tick em andamento terminar (desligamento limpo no SIGTERM). */
  stop(): Promise<void>;
}

/**
 * Laço do worker. Antes de cada tick consulta a prontidão: se Postgres, A ou B não estão de pé, não pega job
 * (pegar job sem conseguir entregar só gastaria tentativas). Cada tick drena a fila (`drain` do runner).
 */
export function startWorkerLoop(options: {
  isReady: () => boolean;
  tick: () => Promise<void>;
  intervalMs: number;
  logger: Logger;
}): WorkerLoop {
  const { isReady, tick, intervalMs, logger } = options;
  let stopped = false;
  let paused = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  const schedule = () => {
    if (!stopped) timer = setTimeout(loop, intervalMs);
  };

  const loop = () => {
    running = (async () => {
      if (!isReady()) {
        if (!paused) logger.warn('worker pausado: dependências fora do ar (/ready falhando)');
        paused = true;
        return;
      }
      if (paused) logger.info('worker retomado: dependências de volta');
      paused = false;
      try {
        await tick();
      } catch (err) {
        logger.error({ err }, 'falha inesperada no tick do worker');
      }
    })().finally(schedule);
  };

  schedule();

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
