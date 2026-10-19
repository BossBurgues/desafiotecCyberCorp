import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';
import { loadAuthConfig } from '../../src/auth.js';
import { buildTestServer, login } from '../helpers/session.js';

test('initSession com senha certa devolve session_token e a sessão lê chamados', async () => {
  const app = buildTestServer();
  try {
    const basic = Buffer.from(`tecnico:${app.authConfig.tecnicoPassword}`).toString('base64');
    const initRes = await app.inject({
      method: 'GET',
      url: '/apirest.php/initSession',
      headers: {
        'App-Token': app.authConfig.appToken,
        Authorization: `Basic ${basic}`,
      },
    });
    assert.equal(initRes.statusCode, 200);
    const { session_token: sessionToken } = initRes.json();
    assert.equal(typeof sessionToken, 'string');
    assert.equal(sessionToken.length, 64);

    const listRes = await app.inject({
      method: 'GET',
      url: '/apirest.php/Ticket',
      headers: {
        'App-Token': app.authConfig.appToken,
        'Session-Token': sessionToken,
      },
    });
    assert.equal(listRes.statusCode, 200);
    assert.deepEqual(listRes.json(), []);
  } finally {
    await app.close();
  }
});

test('initSession com senha errada devolve 401 ERROR_GLPI_LOGIN e registra a tentativa', async () => {
  const app = buildTestServer({
    now: () => Date.parse('2026-10-18T17:03:22Z'),
  });
  try {
    const basic = Buffer.from('tecnico:senha-errada').toString('base64');
    const res = await app.inject({
      method: 'GET',
      url: '/apirest.php/initSession',
      headers: {
        'App-Token': app.authConfig.appToken,
        Authorization: `Basic ${basic}`,
      },
    });

    assert.equal(res.statusCode, 401);
    assert.equal(res.json()[0], 'ERROR_GLPI_LOGIN');

    const denials = app.store.listDenials();
    assert.equal(denials.length, 1);
    assert.equal(denials[0].status, 401);
    assert.equal(denials[0].error_code, 'ERROR_GLPI_LOGIN');
    assert.equal(denials[0].user_id, 1);
    assert.equal(denials[0].login, 'tecnico');
    assert.equal(denials[0].profile, 'tecnico');
    assert.equal(denials[0].occurred_at, '2026-10-18T17:03:22.000Z');
  } finally {
    await app.close();
  }
});

test('sync-bot entra com user_token e não entra com Basic', async () => {
  const app = buildTestServer();
  try {
    const basicBot = Buffer.from(`sync-bot:${app.authConfig.syncBotToken}`).toString('base64');
    const basicRes = await app.inject({
      method: 'GET',
      url: '/apirest.php/initSession',
      headers: {
        'App-Token': app.authConfig.appToken,
        Authorization: `Basic ${basicBot}`,
      },
    });
    assert.equal(basicRes.statusCode, 401);
    assert.equal(basicRes.json()[0], 'ERROR_GLPI_LOGIN');

    const invalidTokenRes = await app.inject({
      method: 'GET',
      url: '/apirest.php/initSession',
      headers: {
        'App-Token': app.authConfig.appToken,
        Authorization: `user_token ${app.authConfig.tecnicoPassword}`,
      },
    });
    assert.equal(invalidTokenRes.statusCode, 401);
    assert.equal(invalidTokenRes.json()[0], 'ERROR_GLPI_LOGIN_USER_TOKEN');

    const botHeaders = await login(app, 'sync-bot');
    const readRes = await app.inject({
      method: 'GET',
      url: '/apirest.php/Ticket',
      headers: botHeaders,
    });
    assert.equal(readRes.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('rota de chamado sem App-Token devolve 401 ERROR_APP_TOKEN_PARAMETERS_MISSING', async () => {
  const app = buildTestServer();
  try {
    const headers = await login(app, 'tecnico');

    const missingAppToken = await app.inject({
      method: 'GET',
      url: '/apirest.php/Ticket',
      headers: {
        'Session-Token': headers['Session-Token'],
      },
    });
    assert.equal(missingAppToken.statusCode, 401);
    assert.equal(missingAppToken.json()[0], 'ERROR_APP_TOKEN_PARAMETERS_MISSING');

    const wrongAppToken = await app.inject({
      method: 'GET',
      url: '/apirest.php/Ticket',
      headers: {
        'App-Token': 'errado',
        'Session-Token': headers['Session-Token'],
      },
    });
    assert.equal(wrongAppToken.statusCode, 401);
    assert.equal(wrongAppToken.json()[0], 'ERROR_WRONG_APP_TOKEN_PARAMETER');

    const missingSession = await app.inject({
      method: 'GET',
      url: '/apirest.php/Ticket',
      headers: {
        'App-Token': headers['App-Token'],
      },
    });
    assert.equal(missingSession.statusCode, 401);
    assert.equal(missingSession.json()[0], 'ERROR_SESSION_TOKEN_MISSING');
  } finally {
    await app.close();
  }
});

test('Session-Token encerrado por killSession não vale mais', async () => {
  const app = buildTestServer();
  try {
    const headers = await login(app, 'tecnico');

    const killRes = await app.inject({
      method: 'GET',
      url: '/apirest.php/killSession',
      headers,
    });
    assert.equal(killRes.statusCode, 200);

    const afterKill = await app.inject({
      method: 'GET',
      url: '/apirest.php/Ticket',
      headers,
    });
    assert.equal(afterKill.statusCode, 401);
    assert.equal(afterKill.json()[0], 'ERROR_SESSION_TOKEN_INVALID');

    const killAgain = await app.inject({
      method: 'GET',
      url: '/apirest.php/killSession',
      headers,
    });
    assert.equal(killAgain.statusCode, 401);
    assert.equal(killAgain.json()[0], 'ERROR_SESSION_TOKEN_INVALID');
  } finally {
    await app.close();
  }
});

test('estagiário vê e abre chamado', async () => {
  const app = buildTestServer({
    timeZone: 'America/Sao_Paulo',
    now: () => Date.parse('2026-10-18T17:00:00Z'),
  });
  try {
    const headers = await login(app, 'estagiario');

    const createRes = await app.inject({
      method: 'POST',
      url: '/apirest.php/Ticket',
      headers,
      payload: {
        input: {
          name: 'Mouse sem funcionar',
          content: '<p>Parou na bancada 4.</p>',
        },
      },
    });
    assert.equal(createRes.statusCode, 201);
    const created = createRes.json();
    assert.equal(created.users_id_recipient, 2);

    const getRes = await app.inject({
      method: 'GET',
      url: `/apirest.php/Ticket/${created.id}`,
      headers,
    });
    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.json().name, 'Mouse sem funcionar');

    const listRes = await app.inject({
      method: 'GET',
      url: '/apirest.php/Ticket',
      headers,
    });
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.json().length, 1);
  } finally {
    await app.close();
  }
});

test('estagiário editando chamado recebe 403 ERROR_RIGHT_MISSING e o chamado não muda', async () => {
  let currentEpoch = Date.parse('2026-10-18T17:00:00Z');
  const app = buildTestServer({
    timeZone: 'America/Sao_Paulo',
    now: () => currentEpoch,
  });
  try {
    const tecnicoHeaders = await login(app, 'tecnico');
    const estagiarioHeaders = await login(app, 'estagiario');

    const createRes = await app.inject({
      method: 'POST',
      url: '/apirest.php/Ticket',
      headers: tecnicoHeaders,
      payload: {
        input: {
          name: 'Servidor de arquivos lento',
          content: '<p>Latência alta.</p>',
          status: 1,
          priority: 3,
        },
      },
    });
    assert.equal(createRes.statusCode, 201);
    const before = createRes.json();

    currentEpoch = Date.parse('2026-10-18T17:10:00Z');

    const putRes = await app.inject({
      method: 'PUT',
      url: `/apirest.php/Ticket/${before.id}`,
      headers: estagiarioHeaders,
      payload: {
        input: {
          status: 2,
          priority: 5,
        },
      },
    });
    assert.equal(putRes.statusCode, 403);
    assert.deepEqual(putRes.json(), [
      'ERROR_RIGHT_MISSING',
      'Perfil estagiario não pode executar ticket.update.',
    ]);

    const afterRes = await app.inject({
      method: 'GET',
      url: `/apirest.php/Ticket/${before.id}`,
      headers: tecnicoHeaders,
    });
    assert.equal(afterRes.statusCode, 200);
    assert.deepEqual(afterRes.json(), before);
  } finally {
    await app.close();
  }
});

test('Técnico soluciona e depois fecha o chamado (status 5 e 6), como no GLPI', async () => {
  const app = buildTestServer();
  try {
    const headers = await login(app, 'tecnico');
    const created = await app.inject({
      method: 'POST',
      url: '/apirest.php/Ticket',
      headers,
      payload: { input: { name: 'Teclado com teclas presas', content: 'Bancada 2.' } },
    });
    assert.equal(created.statusCode, 201);
    const { id } = created.json();

    for (const status of [5, 6]) {
      const res = await app.inject({
        method: 'PUT',
        url: `/apirest.php/Ticket/${id}`,
        headers,
        payload: { input: { status } },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().status, status);
    }
  } finally {
    await app.close();
  }
});

test('estagiário editando chamado inexistente recebe 403, não 404', async () => {
  const app = buildTestServer();
  try {
    const estagiarioHeaders = await login(app, 'estagiario');

    const res = await app.inject({
      method: 'PUT',
      url: '/apirest.php/Ticket/999',
      headers: estagiarioHeaders,
      payload: { input: { status: 2 } },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json()[0], 'ERROR_RIGHT_MISSING');
  } finally {
    await app.close();
  }
});

test('sync-bot não abre chamado nem edita nada além do status (B → A leve)', async () => {
  const app = buildTestServer();
  try {
    const tecnicoHeaders = await login(app, 'tecnico');
    const botHeaders = await login(app, 'sync-bot');

    const created = await app.inject({
      method: 'POST',
      url: '/apirest.php/Ticket',
      headers: tecnicoHeaders,
      payload: { input: { name: 'Chamado base', content: 'Texto' } },
    });
    assert.equal(created.statusCode, 201);

    const botCreate = await app.inject({
      method: 'POST',
      url: '/apirest.php/Ticket',
      headers: botHeaders,
      payload: { input: { name: 'Bot tentando abrir', content: 'Texto' } },
    });
    assert.equal(botCreate.statusCode, 403);
    assert.equal(botCreate.json()[0], 'ERROR_RIGHT_MISSING');

    for (const input of [{ name: 'Bot editando o título' }, { status: 2, priority: 5 }]) {
      const botUpdate = await app.inject({
        method: 'PUT',
        url: '/apirest.php/Ticket/1',
        headers: botHeaders,
        payload: { input },
      });
      assert.equal(botUpdate.statusCode, 403, JSON.stringify(input));
      assert.equal(botUpdate.json()[0], 'ERROR_RIGHT_MISSING');
    }

    const botStatus = await app.inject({
      method: 'PUT',
      url: '/apirest.php/Ticket/1',
      headers: botHeaders,
      payload: { input: { status: 6 } },
    });
    assert.equal(botStatus.statusCode, 200);
    assert.equal(botStatus.json().status, 6);
  } finally {
    await app.close();
  }
});

test('negação fica registrada com usuário, horário UTC e IP e não vaza segredo no log', async () => {
  const logLines = [];
  const logStream = new Writable({
    write(chunk, _encoding, callback) {
      logLines.push(chunk.toString('utf8'));
      callback();
    },
  });

  const app = buildTestServer({
    now: () => Date.parse('2026-10-18T17:03:22Z'),
    logger: { level: 'warn', stream: logStream },
  });

  try {
    const estagiarioHeaders = await login(app, 'estagiario');

    const putRes = await app.inject({
      method: 'PUT',
      url: '/apirest.php/Ticket/42',
      headers: {
        ...estagiarioHeaders,
        'X-Forwarded-For': '203.0.113.7',
      },
      payload: { input: { status: 2 } },
    });
    assert.equal(putRes.statusCode, 403);

    // Tentativa de login inválido para conferir que a senha não aparece no log
    const secretAttempt = 'senha-super-secreta-nao-pode-vazar';
    const badBasic = Buffer.from(`tecnico:${secretAttempt}`).toString('base64');
    await app.inject({
      method: 'GET',
      url: '/apirest.php/initSession',
      headers: {
        'App-Token': app.authConfig.appToken,
        Authorization: `Basic ${badBasic}`,
      },
    });

    const denials = app.store.listDenials();
    assert.equal(denials.length, 2);
    assert.deepEqual(denials[0], {
      id: 1,
      occurred_at: '2026-10-18T17:03:22.000Z',
      status: 403,
      error_code: 'ERROR_RIGHT_MISSING',
      user_id: 2,
      login: 'estagiario',
      profile: 'estagiario',
      action: 'ticket.update',
      method: 'PUT',
      url: '/apirest.php/Ticket/42',
      ticket_id: 42,
      origin_ip: '127.0.0.1',
    });

    const fullLog = logLines.join('');
    assert.ok(fullLog.includes('acesso negado'));
    assert.ok(!fullLog.includes(secretAttempt));
    assert.ok(!fullLog.includes(badBasic));
    assert.ok(!fullLog.includes(estagiarioHeaders['Session-Token']));
  } finally {
    await app.close();
  }

  // Com A_TRUST_PROXY=true, request.ip honra X-Forwarded-For
  const proxiedApp = buildTestServer({
    now: () => Date.parse('2026-10-18T17:05:00Z'),
    env: { A_TRUST_PROXY: 'true' },
  });
  try {
    const estagiarioHeaders = await login(proxiedApp, 'estagiario');
    const res = await proxiedApp.inject({
      method: 'PUT',
      url: '/apirest.php/Ticket/7',
      headers: {
        ...estagiarioHeaders,
        'X-Forwarded-For': '203.0.113.7',
      },
      payload: { input: { status: 2 } },
    });
    assert.equal(res.statusCode, 403);
    const [denial] = proxiedApp.store.listDenials();
    assert.equal(denial.origin_ip, '203.0.113.7');
    assert.equal(denial.occurred_at, '2026-10-18T17:05:00.000Z');
  } finally {
    await proxiedApp.close();
  }
});

test('toda rota de chamado declara a ação que exige', async () => {
  const app = buildTestServer();
  try {
    await app.ready();
    const apiRoutes = app.registeredRoutes.filter(
      (r) =>
        r.url.startsWith('/apirest.php') &&
        r.url !== '/apirest.php/initSession' &&
        r.url !== '/apirest.php/killSession' &&
        r.url !== '/apirest.php/getFullSession' &&
        r.method !== 'HEAD',
    );
    assert.ok(apiRoutes.length >= 4);
    for (const route of apiRoutes) {
      assert.equal(
        typeof route.config.action,
        'string',
        `Rota ${String(route.method)} ${route.url} não declarou config.action`,
      );
    }
  } finally {
    await app.close();
  }
});

test('evento ticket.changed leva o ator da sessão', async () => {
  const app = buildTestServer();
  const events = [];
  app.emitter.on('ticket.changed', (ev) => events.push(ev));

  try {
    const estagiarioHeaders = await login(app, 'estagiario');
    const tecnicoHeaders = await login(app, 'tecnico');

    const createRes = await app.inject({
      method: 'POST',
      url: '/apirest.php/Ticket',
      headers: estagiarioHeaders,
      payload: { input: { name: 'Aberto pelo estagiário', content: 'Detalhe' } },
    });
    assert.equal(createRes.statusCode, 201);

    const updateRes = await app.inject({
      method: 'PUT',
      url: '/apirest.php/Ticket/1',
      headers: tecnicoHeaders,
      payload: { input: { status: 2 } },
    });
    assert.equal(updateRes.statusCode, 200);

    const created = createRes.json();
    const updated = updateRes.json();

    assert.deepEqual(events, [
      {
        ticketId: 1,
        action: 'created',
        dateMod: created.date_mod,
        actor: { id: 2, login: 'estagiario', profile: 'estagiario' },
      },
      {
        ticketId: 1,
        action: 'updated',
        dateMod: updated.date_mod,
        actor: { id: 1, login: 'tecnico', profile: 'tecnico' },
      },
    ]);
  } finally {
    await app.close();
  }
});

test('getFullSession devolve id, login e perfil de cada usuário', async () => {
  const app = buildTestServer();
  try {
    for (const [profile, id] of [
      ['tecnico', 1],
      ['estagiario', 2],
      ['sync-bot', 3],
    ]) {
      const headers = await login(app, profile);
      const res = await app.inject({ method: 'GET', url: '/apirest.php/getFullSession', headers });
      assert.equal(res.statusCode, 200, profile);
      assert.deepEqual(res.json(), {
        session: { glpiID: id, glpiname: profile, glpiactiveprofile: { name: profile } },
      });
      assert.doesNotMatch(res.body, /scrypt|password|token/i);
    }
  } finally {
    await app.close();
  }
});

test('getFullSession sem sessão é 401', async () => {
  const app = buildTestServer();
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/apirest.php/getFullSession',
      headers: { 'App-Token': app.authConfig.appToken },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json()[0], 'ERROR_SESSION_TOKEN_MISSING');
  } finally {
    await app.close();
  }
});

test('API aceita o token da UI', async () => {
  const app = buildTestServer();
  try {
    const basic = Buffer.from(`estagiario:${app.authConfig.estagiarioPassword}`).toString('base64');
    const initRes = await app.inject({
      method: 'GET',
      url: '/apirest.php/initSession',
      headers: { 'App-Token': app.authConfig.uiAppToken, Authorization: `Basic ${basic}` },
    });
    assert.equal(initRes.statusCode, 200);
    const listRes = await app.inject({
      method: 'GET',
      url: '/apirest.php/Ticket',
      headers: {
        'App-Token': app.authConfig.uiAppToken,
        'Session-Token': initRes.json().session_token,
      },
    });
    assert.equal(listRes.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('token da UI errado é 401 e fica em access_denials', async () => {
  const app = buildTestServer();
  try {
    const headers = await login(app, 'tecnico');
    const res = await app.inject({
      method: 'GET',
      url: '/apirest.php/Ticket',
      headers: { ...headers, 'App-Token': `${app.authConfig.uiAppToken}x` },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json()[0], 'ERROR_WRONG_APP_TOKEN_PARAMETER');
    assert.equal(app.store.listDenials().at(-1).error_code, 'ERROR_WRONG_APP_TOKEN_PARAMETER');
  } finally {
    await app.close();
  }
});

const PROD_ENV = Object.freeze({
  NODE_ENV: 'production',
  A_APP_TOKEN: 'prod-app',
  A_TECNICO_PASSWORD: 'prod-tec',
  A_ESTAGIARIO_PASSWORD: 'prod-est',
  A_SYNC_BOT_TOKEN: 'prod-bot',
});

test('produção sem A_UI_APP_TOKEN não sobe', () => {
  assert.throws(() => loadAuthConfig({ ...PROD_ENV }), /A_UI_APP_TOKEN ausente em NODE_ENV=production/);
});

test('A_UI_APP_TOKEN igual ao A_APP_TOKEN não sobe', () => {
  assert.throws(
    () => loadAuthConfig({ ...PROD_ENV, A_UI_APP_TOKEN: 'prod-app' }),
    /A_UI_APP_TOKEN deve ser diferente de A_APP_TOKEN/,
  );
  assert.throws(
    () => loadAuthConfig({}, { appToken: 'mesmo', uiAppToken: 'mesmo' }),
    /A_UI_APP_TOKEN deve ser diferente/,
  );
});
