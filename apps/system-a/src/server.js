import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { DEFAULT_DB_PATH, TicketStore } from './store.js';
import { DEFAULT_TIMEZONE, glpiError } from './tickets.js';

export function buildServer({
  dbPath = process.env.A_DB_PATH || DEFAULT_DB_PATH,
  timeZone = process.env.A_TIMEZONE || DEFAULT_TIMEZONE,
  now = Date.now,
  logger = false,
} = {}) {
  const app = Fastify({ logger });
  const store = new TicketStore(dbPath);

  app.decorate('store', store);
  app.decorate('timeZone', timeZone);
  app.decorate('now', now);

  app.addHook('onClose', async () => {
    store.close();
  });

  app.setNotFoundHandler((_request, reply) => {
    reply
      .code(404)
      .send(glpiError('ERROR_ITEM_NOT_FOUND', 'Recurso não encontrado no Sistema A.'));
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error.glpiCode && error.statusCode) {
      reply.code(error.statusCode).send(glpiError(error.glpiCode, error.message));
      return;
    }
    if (error.statusCode === 400 || error.validation) {
      reply
        .code(400)
        .send(glpiError('ERROR_INVALID_INPUT', error.message || 'Dados de entrada inválidos.'));
      return;
    }
    reply
      .code(error.statusCode || 500)
      .send(glpiError('ERROR_INTERNAL', error.message || 'Erro interno no Sistema A.'));
  });

  return app;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const port = Number(process.env.PORT || 3001);
  const server = buildServer({ logger: true });
  server.listen({ port, host: '0.0.0.0' }).catch((err) => {
    server.log.error(err);
    process.exit(1);
  });
}
