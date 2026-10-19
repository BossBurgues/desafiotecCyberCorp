import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import {
  ACTIONS,
  AuthError,
  ForbiddenError,
  PROFILES,
  can,
  hashToken,
  loadAuthConfig,
  parseAuthorization,
  validateAppTokenHeader,
  validateSessionTokenHeader,
  verifyPassword,
} from './auth.js';
import { CATEGORIES, LOCATIONS, findById, publicUser } from './catalog.js';
import { DEFAULT_DB_PATH, TicketStore } from './store.js';
import {
  DEFAULT_TIMEZONE,
  TicketNotFoundError,
  buildListMeta,
  createTicketEmitter,
  glpiError,
  parseListQuery,
  formatLocalDateTime,
  parseTicketId,
  prepareNewTicket,
  prepareTicketUpdate,
} from './tickets.js';
import { UI_SECURITY_HEADERS, detectFeatures, loadUiAssets } from './ui.js';
import { createWebhookDispatcher, loadWebhookConfig } from './webhooks.js';

// O sync-bot mexe só no estado (B → A leve) e na lixeira (exclusão feita no B, ADR-015); o resto é do Técnico
const SYNC_BOT_FIELDS = new Set(['status', 'is_deleted']);

class TicketDeletedError extends Error {
  constructor(id) {
    super(`Chamado ${id} está na lixeira: restaure antes de editar.`);
    this.glpiCode = 'ERROR_TICKET_DELETED';
    this.statusCode = 409;
  }
}

const SESSION_ONLY_ROUTES = new Set([
  '/apirest.php/initSession',
  '/apirest.php/killSession',
  '/apirest.php/getFullSession',
]);

/**
 * Como no GLPI: entrar em Solucionado (5) grava `solvedate`; entrar em Fechado (6) grava `closedate` (e a
 * `solvedate`, se faltar); reabrir (sair de 5/6 para um status aberto) limpa as duas. Quem mandar as datas explicitamente vence.
 */
function lifecycleDates(patch, existing) {
  if (!Object.hasOwn(patch, 'status')) {
    return patch;
  }
  const out = { ...patch };
  const at = patch.date_mod;
  if (patch.status === 5 && existing?.status !== 5) {
    out.solvedate ??= at;
    out.closedate ??= null;
  } else if (patch.status === 6 && existing?.status !== 6) {
    out.closedate ??= at;
    if (!existing?.solvedate && !Object.hasOwn(patch, 'solvedate')) {
      out.solvedate = at;
    }
  } else if (patch.status < 5 && existing?.status >= 5) {
    // reaberto: deixa de estar solucionado/fechado
    out.solvedate ??= null;
    out.closedate ??= null;
  }
  return out;
}

/** Os IDs do chamado precisam existir nos catálogos (como as chaves estrangeiras do GLPI). */
function assertReferences(fields, store) {
  const fail = (msg) => {
    const err = new Error(msg);
    err.glpiCode = 'ERROR_INVALID_INPUT';
    err.statusCode = 400;
    throw err;
  };
  if (fields.itilcategories_id != null && !findById(CATEGORIES, fields.itilcategories_id)) {
    fail(`Categoria ${fields.itilcategories_id} não existe.`);
  }
  if (fields.locations_id != null && !findById(LOCATIONS, fields.locations_id)) {
    fail(`Local ${fields.locations_id} não existe.`);
  }
  if (fields.users_id_recipient != null && !store.getUserById(fields.users_id_recipient)) {
    fail(`Usuário ${fields.users_id_recipient} não existe.`);
  }
  if (fields.users_id_assign != null && store.getUserById(fields.users_id_assign)?.profile !== 'tecnico') {
    fail(`O chamado só pode ser atribuído a um Técnico (usuário ${fields.users_id_assign}).`);
  }
}

function parsePositiveIdOrNull(rawId) {
  if (rawId === undefined || rawId === null) {
    return null;
  }
  const str = String(rawId);
  if (!/^[1-9]\d*$/.test(str)) {
    return null;
  }
  const num = Number(str);
  return Number.isSafeInteger(num) ? num : null;
}

export function buildServer({
  dbPath = process.env.A_DB_PATH || DEFAULT_DB_PATH,
  timeZone = process.env.A_TIMEZONE || DEFAULT_TIMEZONE,
  now = Date.now,
  emitter = createTicketEmitter(),
  logger = false,
  env = process.env,
  auth = {},
  webhook: webhookOverrides = {},
  trustProxy = env.A_TRUST_PROXY === 'true' || env.A_TRUST_PROXY === true,
  uiDir,
} = {}) {
  const authConfig = loadAuthConfig(env, auth);
  const appTokens = [authConfig.appToken, authConfig.uiAppToken];
  const webhookConfig = loadWebhookConfig(env, webhookOverrides);
  const uiAssets = loadUiAssets(uiDir);
  const app = Fastify({ logger, trustProxy });
  const store = new TicketStore(dbPath);
  store.seedUsers(authConfig);

  const webhook = createWebhookDispatcher(webhookConfig, {
    fetch: webhookOverrides.fetch,
    now,
    random: webhookOverrides.random,
    uuid: webhookOverrides.uuid,
    log: app.log,
  });
  emitter.on('ticket.changed', webhook.handle);

  const registeredRoutes = [];

  app.decorate('store', store);
  app.decorate('authConfig', authConfig);
  app.decorate('webhookConfig', webhookConfig);
  app.decorate('webhook', webhook);
  app.decorate('timeZone', timeZone);
  app.decorate('now', now);
  app.decorate('emitter', emitter);
  app.decorate('registeredRoutes', registeredRoutes);

  app.addHook('onRoute', (routeOptions) => {
    registeredRoutes.push({
      method: routeOptions.method,
      url: routeOptions.url,
      config: routeOptions.config || {},
    });
  });

  app.addHook('onClose', async () => {
    emitter.off('ticket.changed', webhook.handle);
    await webhook.close();
    store.close();
  });

  app.setNotFoundHandler((_request, reply) => {
    reply
      .code(404)
      .send(glpiError('ERROR_ITEM_NOT_FOUND', 'Recurso não encontrado no Sistema A.'));
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AuthError) {
      const instant = typeof now === 'function' ? now() : now;
      const occurredAt = new Date(instant).toISOString();
      const action = error.context?.action ?? request.routeOptions?.config?.action ?? null;
      const denial = store.recordDenial({
        occurred_at: occurredAt,
        status: error.statusCode,
        error_code: error.glpiCode,
        user_id: request.user?.id ?? error.context?.userId ?? null,
        login: request.user?.login ?? error.context?.login ?? null,
        profile: request.user?.profile ?? error.context?.profile ?? null,
        action,
        method: request.method,
        url: request.url,
        ticket_id: parsePositiveIdOrNull(request.params?.id),
        origin_ip: request.ip,
      });
      // O log de auditoria registra apenas os campos da tabela access_denials, nunca senha, token ou cabeçalho Authorization.
      request.log.warn({ denial }, 'acesso negado');
      reply.code(error.statusCode).send(glpiError(error.glpiCode, error.message));
      return;
    }
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

  // Calculado depois de registradas todas as rotas: a UI liga conversa/aprovações sozinha quando S1.4/S1.5 entrarem.
  let uiFeatures = { followups: false, solutions: false };
  app.addHook('onReady', async () => {
    uiFeatures = detectFeatures(registeredRoutes);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url === '/ui' || request.url.startsWith('/ui/')) {
      reply.headers(UI_SECURITY_HEADERS);
      // Revalida a cada carga: depois de um deploy o navegador nunca fica com o app.js antigo (o config.json já é no-store)
      if (!reply.hasHeader('cache-control')) {
        reply.header('cache-control', 'no-cache');
      }
    }
    return payload;
  });

  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', null);

  // Fora do prefixo /apirest.php: não passa pelo preHandler de sessão (usado pelo healthcheck do container).
  app.get('/health', async (request, reply) => {
    try {
      store.ping();
      return { status: 'ok' };
    } catch (err) {
      request.log.error({ err }, 'health: banco indisponível');
      return reply.code(503).send({ status: 'error' });
    }
  });

  // Interface web (S1.6): fora de /apirest.php, não exige sessão; a API continua exigindo App-Token e sessão.
  app.get('/', (_request, reply) => reply.redirect('/ui/', 302));
  app.get('/ui', (_request, reply) => reply.redirect('/ui/', 302));

  const sendUiAsset = (reply, name) => {
    const asset = uiAssets.get(name);
    if (!asset) {
      return reply
        .code(404)
        .send(glpiError('ERROR_ITEM_NOT_FOUND', 'Recurso não encontrado no Sistema A.'));
    }
    return reply.type(asset.contentType).send(asset.body);
  };

  app.get('/ui/', (_request, reply) => sendUiAsset(reply, 'index.html'));

  app.get('/ui/config.json', (_request, reply) =>
    reply
      .header('cache-control', 'no-store')
      .send({ appToken: authConfig.uiAppToken, features: uiFeatures }),
  );

  app.get('/ui/:file', (request, reply) => sendUiAsset(reply, request.params.file));

  app.register(
    async (api) => {
      api.addHook('preHandler', async (request) => {
        const routeUrl = request.routeOptions.url;
        if (routeUrl === '/apirest.php/initSession') {
          return;
        }
        validateAppTokenHeader(request.headers['app-token'], appTokens);
        const { token, user } = validateSessionTokenHeader(
          request.headers['session-token'],
          store,
        );
        request.sessionToken = token;
        request.user = user;

        if (SESSION_ONLY_ROUTES.has(routeUrl)) {
          return;
        }

        const action = request.routeOptions.config?.action;
        if (!action) {
          const err = new Error(`Rota ${routeUrl} sem config.action declarada.`);
          err.glpiCode = 'ERROR_INTERNAL';
          err.statusCode = 500;
          throw err;
        }

        // Permissão é conferida antes de validar o corpo ou buscar o chamado no banco para não revelar se o ID existe.
        if (!can(user.profile, action)) {
          throw new ForbiddenError(user.profile, action);
        }
      });

      api.get('/initSession', async (request) => {
        validateAppTokenHeader(request.headers['app-token'], appTokens);
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

      // Só os campos que a UI usa; nunca senha nem token.
      api.get('/getFullSession', async (request) => ({
        session: {
          glpiID: request.user.id,
          glpiname: request.user.login,
          glpiactiveprofile: { name: request.user.profile },
        },
      }));

      api.get(
        '/Ticket',
        { config: { action: ACTIONS.TICKET_READ } },
        async (request, reply) => {
          const { offset, start, limit, sort, order, dateModGte, isDeleted } = parseListQuery(request.query);
          const total = store.count({ dateModGte, isDeleted });
          const items =
            start >= total ? [] : store.list({ offset, limit, sort, order, dateModGte, isDeleted });
          const { statusCode, contentRange } = buildListMeta({
            start,
            count: items.length,
            total,
          });
          return reply.header('Content-Range', contentRange).code(statusCode).send(items);
        },
      );

      api.post(
        '/Ticket',
        { config: { action: ACTIONS.TICKET_CREATE } },
        async (request, reply) => {
          const ticketData = lifecycleDates(
            prepareNewTicket(request.body, {
              now,
              timeZone,
              defaultRecipientId: request.user.id,
            }),
            null,
          );
          assertReferences(ticketData, store);
          const created = store.insert(ticketData);
          emitter.emit('ticket.changed', {
            ticketId: created.id,
            action: 'created',
            dateMod: created.date_mod,
            actor: {
              id: request.user.id,
              login: request.user.login,
              profile: request.user.profile,
            },
          });
          return reply.code(201).send(created);
        },
      );

      // Acompanhamentos (S1.4): notas da conversa do chamado. O sync-bot escreve aqui o que veio do B (B → A leve)
      api.get(
        '/Ticket/:id/ITILFollowup',
        { config: { action: ACTIONS.TICKET_READ } },
        async (request) => {
          const id = parseTicketId(request.params.id);
          if (!store.getById(id)) {
            throw new TicketNotFoundError(`Chamado ${id} não encontrado.`);
          }
          return store.listFollowups(id);
        },
      );

      api.post(
        '/ITILFollowup',
        { config: { action: ACTIONS.FOLLOWUP_CREATE } },
        async (request, reply) => {
          const input = request.body?.input;
          const bad = (msg) => {
            const err = new Error(msg);
            err.glpiCode = 'ERROR_INVALID_INPUT';
            err.statusCode = 400;
            throw err;
          };
          if (!input || typeof input !== 'object' || Array.isArray(input)) bad('O corpo deve ter "input".');
          for (const key of Object.keys(input)) {
            if (!['itemtype', 'items_id', 'content', 'is_private'].includes(key)) bad(`Campo não permitido no input: ${key}.`);
          }
          if (input.itemtype !== 'Ticket') bad('itemtype deve ser "Ticket".');
          if (!Number.isInteger(input.items_id) || input.items_id < 1) bad('items_id deve ser um inteiro >= 1.');
          if (typeof input.content !== 'string' || input.content.trim() === '') bad('content é obrigatório.');
          const isPrivate = input.is_private ?? 0;
          if (isPrivate !== 0 && isPrivate !== 1) bad('is_private deve ser 0 ou 1.');
          if (!store.getById(input.items_id)) {
            throw new TicketNotFoundError(`Chamado ${input.items_id} não encontrado.`);
          }
          const at = formatLocalDateTime(typeof now === 'function' ? now() : now, timeZone);
          const created = store.insertFollowup({
            items_id: input.items_id,
            users_id: request.user.id,
            content: input.content,
            is_private: isPrivate,
            date: at,
            date_mod: at,
          });
          return reply.code(201).send(created);
        },
      );

      // Catálogos (somente leitura): o mesmo direito de ler chamados, inclusive para o sync-bot
      const catalogRoute = (path, list) => {
        api.get(path, { config: { action: ACTIONS.TICKET_READ } }, async () => list());
        api.get(`${path}/:id`, { config: { action: ACTIONS.TICKET_READ } }, async (request) => {
          const id = parseTicketId(request.params.id);
          const item = list().find((x) => x.id === id);
          if (!item) {
            const err = new Error(`${path.slice(1)} ${id} não encontrado.`);
            err.glpiCode = 'ERROR_ITEM_NOT_FOUND';
            err.statusCode = 404;
            throw err;
          }
          return item;
        });
      };
      catalogRoute('/ITILCategory', () => CATEGORIES);
      catalogRoute('/Location', () => LOCATIONS);
      catalogRoute('/User', () => store.listUsers().map(publicUser));

      api.get(
        '/Ticket/:id',
        { config: { action: ACTIONS.TICKET_READ } },
        async (request) => {
          const id = parseTicketId(request.params.id);
          const ticket = store.getById(id);
          if (!ticket) {
            throw new TicketNotFoundError(`Chamado ${id} não encontrado.`);
          }
          return ticket;
        },
      );

      api.put(
        '/Ticket/:id',
        { config: { action: ACTIONS.TICKET_UPDATE } },
        async (request) => {
          const id = parseTicketId(request.params.id);
          const existing = store.getById(id);
          if (!existing) {
            throw new TicketNotFoundError(`Chamado ${id} não encontrado.`);
          }
          if (request.user.profile === PROFILES.SYNC_BOT) {
            const keys = Object.keys(request.body?.input ?? {});
            if (keys.length === 0 || keys.some((k) => !SYNC_BOT_FIELDS.has(k))) {
              throw new ForbiddenError(request.user.profile, `${ACTIONS.TICKET_UPDATE} (só status e is_deleted)`);
            }
          }
          const patch = lifecycleDates(prepareTicketUpdate(request.body, { now, timeZone }), existing);
          // Na lixeira, como no GLPI, o chamado só pode ser restaurado (is_deleted: 0) antes de qualquer outra edição
          if (existing.is_deleted === 1 && patch.is_deleted !== 0) {
            throw new TicketDeletedError(id);
          }
          assertReferences(patch, store);
          return applyUpdate(request, id, patch);
        },
      );

      // Excluir = mandar para a lixeira (como o DELETE sem force_purge da API do GLPI). Reversível: PUT is_deleted 0
      api.delete(
        '/Ticket/:id',
        { config: { action: ACTIONS.TICKET_UPDATE } },
        async (request) => {
          const id = parseTicketId(request.params.id);
          const existing = store.getById(id);
          if (!existing) {
            throw new TicketNotFoundError(`Chamado ${id} não encontrado.`);
          }
          if (existing.is_deleted !== 1) {
            applyUpdate(request, id, prepareTicketUpdate({ input: { is_deleted: 1 } }, { now, timeZone }));
          }
          return [{ [id]: true, message: '' }];
        },
      );

      // Grava e avisa o sync. A exclusão e a restauração saem como "updated": o evento é só um sinal e o worker relê o A
      function applyUpdate(request, id, patch) {
        const updated = store.update(id, patch);
        emitter.emit('ticket.changed', {
          ticketId: updated.id,
          action: 'updated',
          dateMod: updated.date_mod,
          actor: {
            id: request.user.id,
            login: request.user.login,
            profile: request.user.profile,
          },
        });
        return updated;
      }
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

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      server.log.info({ signal }, 'encerrando');
      const timer = setTimeout(() => process.exit(1), 10_000).unref();
      server.close().then(
        () => {
          clearTimeout(timer);
          process.exit(0);
        },
        (err) => {
          server.log.error(err);
          process.exit(1);
        },
      );
    });
  }
}
