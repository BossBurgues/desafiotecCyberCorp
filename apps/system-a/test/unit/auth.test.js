import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIONS,
  AuthError,
  DEFAULT_DEV_CREDENTIALS,
  PROFILES,
  can,
  hashPassword,
  hashToken,
  loadAuthConfig,
  parseAuthorization,
  validateAppTokenHeader,
  verifyPassword,
} from '../../src/auth.js';

test('matriz de permissões avalia as 18 combinações de perfil × ação conforme a seção 6 do plano', () => {
  const expected = [
    [PROFILES.TECNICO, ACTIONS.TICKET_READ, true],
    [PROFILES.TECNICO, ACTIONS.TICKET_CREATE, true],
    [PROFILES.TECNICO, ACTIONS.TICKET_UPDATE, true],
    [PROFILES.TECNICO, ACTIONS.FOLLOWUP_CREATE, true],
    [PROFILES.TECNICO, ACTIONS.SOLUTION_CREATE, true],
    [PROFILES.TECNICO, ACTIONS.SOLUTION_DECIDE, true],

    [PROFILES.ESTAGIARIO, ACTIONS.TICKET_READ, true],
    [PROFILES.ESTAGIARIO, ACTIONS.TICKET_CREATE, true],
    [PROFILES.ESTAGIARIO, ACTIONS.TICKET_UPDATE, false],
    [PROFILES.ESTAGIARIO, ACTIONS.FOLLOWUP_CREATE, false],
    [PROFILES.ESTAGIARIO, ACTIONS.SOLUTION_CREATE, false],
    [PROFILES.ESTAGIARIO, ACTIONS.SOLUTION_DECIDE, false],

    [PROFILES.SYNC_BOT, ACTIONS.TICKET_READ, true],
    [PROFILES.SYNC_BOT, ACTIONS.TICKET_CREATE, false],
    [PROFILES.SYNC_BOT, ACTIONS.TICKET_UPDATE, true], // só o status (conferido na rota)
    [PROFILES.SYNC_BOT, ACTIONS.FOLLOWUP_CREATE, true],
    [PROFILES.SYNC_BOT, ACTIONS.SOLUTION_CREATE, true],
    [PROFILES.SYNC_BOT, ACTIONS.SOLUTION_DECIDE, false],
  ];

  assert.equal(expected.length, 18);
  for (const [profile, action, allowed] of expected) {
    assert.equal(
      can(profile, action),
      allowed,
      `Esperado can(${profile}, ${action}) === ${allowed}`,
    );
  }
});

test('can lança erro em ação desconhecida e nega perfil desconhecido', () => {
  assert.throws(() => can(PROFILES.TECNICO, 'ticket.delete'), /Ação de permissão desconhecida/);
  assert.equal(can('visitante', ACTIONS.TICKET_READ), false);
});

test('parseAuthorization decodifica Basic preservando dois-pontos dentro da senha e decodifica user_token', () => {
  const b64 = Buffer.from('tecnico:minha:senha:complexa', 'utf8').toString('base64');
  const basic = parseAuthorization(`Basic ${b64}`);
  assert.deepEqual(basic, {
    kind: 'basic',
    login: 'tecnico',
    password: 'minha:senha:complexa',
  });

  const tokenAuth = parseAuthorization('user_token segredo-bot-123');
  assert.deepEqual(tokenAuth, {
    kind: 'user_token',
    token: 'segredo-bot-123',
  });
});

test('parseAuthorization rejeita cabeçalho ausente ou malformado com 401 ERROR_LOGIN_PARAMETERS_MISSING', () => {
  const invalidHeaders = [
    undefined,
    '',
    '   ',
    'Bearer abc',
    'Basic',
    'Basic !!!nao-base64!!!',
    `Basic ${Buffer.from('sem-dois-pontos', 'utf8').toString('base64')}`,
    `Basic ${Buffer.from(': senha-sem-login', 'utf8').toString('base64')}`,
    `Basic ${Buffer.from('login-sem-senha:', 'utf8').toString('base64')}`,
    'user_token   ',
  ];

  for (const header of invalidHeaders) {
    assert.throws(
      () => parseAuthorization(header),
      (err) =>
        err instanceof AuthError &&
        err.statusCode === 401 &&
        err.glpiCode === 'ERROR_LOGIN_PARAMETERS_MISSING',
      `Deveria rejeitar header: ${String(header)}`,
    );
  }
});

test('hashPassword e verifyPassword validam senha com scrypt e sal aleatório, e hashToken gera SHA-256', () => {
  const h1 = hashPassword('segredo-123');
  const h2 = hashPassword('segredo-123');
  assert.notEqual(h1, h2, 'Sal aleatório deve produzir hashes distintos');

  assert.equal(verifyPassword('segredo-123', h1), true);
  assert.equal(verifyPassword('segredo-123', h2), true);
  assert.equal(verifyPassword('senha-errada', h1), false);
  assert.equal(verifyPassword('segredo-123', 'formato-invalido'), false);

  const tokenHash = hashToken('meu-token');
  assert.match(tokenHash, /^[0-9a-f]{64}$/);
  assert.equal(tokenHash, hashToken('meu-token'));
  assert.notEqual(tokenHash, hashToken('outro-token'));
});

test('validateAppTokenHeader diferencia cabeçalho ausente de valor incorreto', () => {
  assert.doesNotThrow(() => validateAppTokenHeader('app-123', 'app-123'));

  assert.throws(
    () => validateAppTokenHeader(undefined, 'app-123'),
    (err) => err instanceof AuthError && err.glpiCode === 'ERROR_APP_TOKEN_PARAMETERS_MISSING',
  );

  assert.throws(
    () => validateAppTokenHeader('errado', 'app-123'),
    (err) => err instanceof AuthError && err.glpiCode === 'ERROR_WRONG_APP_TOKEN_PARAMETER',
  );
});

test('loadAuthConfig exige todas as credenciais em NODE_ENV=production e usa defaults fora de produção', () => {
  const devCfg = loadAuthConfig({});
  assert.deepEqual(devCfg, DEFAULT_DEV_CREDENTIALS);

  assert.throws(
    () => loadAuthConfig({ NODE_ENV: 'production' }),
    /A_APP_TOKEN ausente em NODE_ENV=production/,
  );

  assert.throws(
    () =>
      loadAuthConfig({
        NODE_ENV: 'production',
        A_APP_TOKEN: 'ok',
        A_TECNICO_PASSWORD: 'ok',
        A_ESTAGIARIO_PASSWORD: 'ok',
        A_UI_APP_TOKEN: 'ok-ui',
      }),
    /A_SYNC_BOT_TOKEN ausente em NODE_ENV=production/,
  );

  const prodCfg = loadAuthConfig({
    NODE_ENV: 'production',
    A_APP_TOKEN: 'prod-app',
    A_UI_APP_TOKEN: 'prod-ui',
    A_TECNICO_PASSWORD: 'prod-tec',
    A_ESTAGIARIO_PASSWORD: 'prod-est',
    A_SYNC_BOT_TOKEN: 'prod-bot',
  });
  assert.deepEqual(prodCfg, {
    appToken: 'prod-app',
    uiAppToken: 'prod-ui',
    tecnicoPassword: 'prod-tec',
    estagiarioPassword: 'prod-est',
    syncBotToken: 'prod-bot',
  });
});
