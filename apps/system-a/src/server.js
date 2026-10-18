import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { DEFAULT_DB_PATH, TicketStore } from './store.js';
import {
  DEFAULT_TIMEZONE,
  TicketNotFoundError,
  buildListMeta,
  glpiError,
  parseListQuery,
  parseTicketId,
  prepareNewTicket,
} from './tickets.js';

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

  app.register(
    async (api) => {
      api.get('/Ticket', async (request, reply) => {
        const { offset, start, limit, sort, order } = parseListQuery(request.query);
        const total = store.count();
        const items =
          start >= total ? [] : store.list({ offset, limit, sort, order });
        const { statusCode, contentRange } = buildListMeta({
          start,
          count: items.length,
          total,
        });
        return reply.header('Content-Range', contentRange).code(statusCode).send(items);
      });

      api.post('/Ticket', async (request, reply) => {
        const ticketData = prepareNewTicket(request.body, { now, timeZone });
        const created = store.insert(ticketData);
        return reply.code(201).send(created);
      });

      api.get('/Ticket/:id', async (request) => {
        const id = parseTicketId(request.params.id);
        const ticket = store.getById(id);
        if (!ticket) {
          throw new TicketNotFoundError(`Chamado ${id} não encontrado.`);
        }
        return ticket;
      });
    },
    { prefix: '/apirest.php' },
  );

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
