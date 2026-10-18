import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyPluginAsync } from 'fastify';
import type { Logger } from 'pino';
import type { Readiness } from './readiness.js';

export const CORRELATION_HEADER = 'x-correlation-id';

// O ID vindo de fora vai para todos os logs: só aceitamos um formato curto e sem quebra de linha (evita forjar log)
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function correlationIdFrom(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return value && SAFE_CORRELATION_ID.test(value) ? value : randomUUID();
}

export function buildServer(options: {
  logger: Logger;
  readiness: Readiness;
  /** Rotas extras (webhook, dashboard), registradas como plugins depois das de saúde. */
  plugins?: FastifyPluginAsync[];
}) {
  const app = Fastify({
    loggerInstance: options.logger,
    genReqId: (req) => correlationIdFrom(req.headers[CORRELATION_HEADER]),
    logController: new LogController({ requestIdLogLabel: 'correlation_id' }),
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header(CORRELATION_HEADER, req.id);
  });

  // Liveness: o processo responde. Não olha dependências, para o orquestrador não reiniciar o sync por causa do B
  app.get('/health', async () => ({ status: 'ok' }));

  // Readiness: Postgres, A e B checados agora. 503 enquanto qualquer um falhar (o worker também pausa)
  app.get('/ready', async (_req, reply) => {
    const report = await options.readiness.refresh();
    return reply.code(report.ready ? 200 : 503).send(report);
  });

  for (const plugin of options.plugins ?? []) app.register(plugin);

  return app;
}
