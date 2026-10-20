import type { Logger } from 'pino';

export interface Loop {
  /** Para de agendar e espera o ciclo em andamento terminar (desligamento limpo no SIGTERM). */
  stop(): Promise<void>;
}

/**
 * Laço periódico do poller do A e da varredura do B: um ciclo a cada `intervalMs`, só com as dependências de pé
 * (/ready). Erro num ciclo é logado e o próximo tenta de novo; o intervalo conta do fim do ciclo, então dois nunca
 * se sobrepõem.
 */
export function startLoop(options: {
  run: () => Promise<unknown>;
  intervalMs: number;
  /** Espera antes do primeiro ciclo (o poller começa na hora; a varredura espera um intervalo). */
  firstDelayMs: number;
  isReady: () => boolean;
  logger: Logger;
  /** Mensagem do log quando um ciclo falha. */
  failMessage: string;
}): Loop {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  const loop = () => {
    running = (async () => {
      if (!options.isReady()) return;
      try {
        await options.run();
      } catch (err) {
        options.logger.warn({ err }, options.failMessage);
      }
    })().finally(() => {
      if (!stopped) timer = setTimeout(loop, options.intervalMs);
    });
  };
  timer = setTimeout(loop, options.firstDelayMs);
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
