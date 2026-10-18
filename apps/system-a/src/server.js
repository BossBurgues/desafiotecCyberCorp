import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import {
  AuthError,
  hashToken,
  loadAuthConfig,
  parseAuthorization,
  validateAppTokenHeader,
  validateSessionTokenHeader,
  verifyPassword,
} from './auth.js';
import { DEFAULT_DB_PATH, TicketStore } from './store.js';
import {
  DEFAULT_TIMEZONE,
  TicketNotFoundError,
  buildListMeta,
  createTicketEmitter,
  glpiError,
  parseListQuery,
  parseTicketId,
  prepareNewTicket,
  prepareTicketUpdate,
} from './tickets.js';

export function buildServer({
  dbPath = process.env.A_DB_PATH || DEFAULT_DB_PATH,
  timeZone = process.env.A_TIMEZONE || DEFAULT_TIMEZONE,
  now = Date.now,
  emitter = createTicketEmitter(),
  logger = false,
  env = process.env,
  auth = {},
} = {}) {
  const authConfig = loadAuthConfig(env, auth);
  const app = Fastify({ logger });
  const store = new TicketStore(dbPath);
  store.seedUsers(authConfig);

  app.decorate('store', store);
  app.decorate('authConfig', authConfig);
  app.decorate('timeZone', timeZone);
  app.decorate('now', now);
  app.decorate('emitter', emitter);

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

  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', null);

  app.register(
    async (api) => {
      api.addHook('preHandler', async (request) => {
        if (request.routeOptions.url === '/apirest.php/initSession') {
          return;
        }
        validateAppTokenHeader(request.headers['app-token'], authConfig.appToken);
        const { token, user } = validateSessionTokenHeader(
          request.headers['session-token'],
          store,
        );
        request.sessionToken = token;
        request.user = user;
      });

      api.get('/initSession', async (request) => {
        validateAppTokenHeader(request.headers['app-token'], authConfig.appToken);
        const parsed = parseAuthorization(request.headers.authorization);

        if (parsed.kind === 'basic') {
          const user = store.findUserByLogin(parsed.login);
          if (!user || !user.password_hash || !verifyPassword(parsed.password, user.password_hash)) {
            throw new AuthError('ERROR_GLPI_LOGIN', 'Credenciais de login inválidas.', 401, {
              login: parsed.login,
              userId: user?.id ?? null,
              profile: user?.profile ?? null,
            });
          }
          const sessionToken = store.createSession(user.id, now);
          return { session_token: sessionToken };
        }

        const user = store.findUserByApiTokenHash(hashToken(parsed.token));
        if (!user) {
          throw new AuthError(
            'ERROR_GLPI_LOGIN_USER_TOKEN',
            'Token de usuário inválido.',
            401,
          );
        }
        const sessionToken = store.createSession(user.id, now);
        return { session_token: sessionToken };
      });

      api.get('/killSession', async (request, reply) => {
        store.deleteSession(request.sessionToken);
        return reply.code(200).send();
      });

      api.get('/Ticket', async (request, reply) => {
        const { offset, start, limit, sort, order, dateModGte } = parseListQuery(request.query);
        const total = store.count({ dateModGte });
        const items =
          start >= total ? [] : store.list({ offset, limit, sort, order, dateModGte });
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
        emitter.emit('ticket.changed', { ticketId: created.id, action: 'created' });
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

      api.put('/Ticket/:id', async (request) => {
        const id = parseTicketId(request.params.id);
        const existing = store.getById(id);
        if (!existing) {
          throw new TicketNotFoundError(`Chamado ${id} não encontrado.`);
        }
        const patch = prepareTicketUpdate(request.body, { now, timeZone });
        const updated = store.update(id, patch);
        emitter.emit('ticket.changed', { ticketId: updated.id, action: 'updated' });
        return updated;
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
