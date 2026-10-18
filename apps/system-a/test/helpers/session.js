import assert from 'node:assert/strict';
import { PROFILES } from '../../src/auth.js';
import { buildServer } from '../../src/server.js';

export const TEST_AUTH_CONFIG = Object.freeze({
  appToken: 'test-app-token',
  uiAppToken: 'test-ui-app-token',
  tecnicoPassword: 'test-tecnico-password',
  estagiarioPassword: 'test-estagiario-password',
  syncBotToken: 'test-sync-bot-token',
});

export function buildTestServer(opts = {}) {
  return buildServer({
    dbPath: ':memory:',
    ...opts,
    auth: {
      ...TEST_AUTH_CONFIG,
      ...(opts.auth || {}),
    },
    webhook: {
      enabled: false,
      ...(opts.webhook || {}),
    },
  });
}

export async function login(app, profile = PROFILES.TECNICO) {
  const { appToken, tecnicoPassword, estagiarioPassword, syncBotToken } = app.authConfig;

  let authorization;
  if (profile === PROFILES.TECNICO) {
    const b64 = Buffer.from(`tecnico:${tecnicoPassword}`, 'utf8').toString('base64');
    authorization = `Basic ${b64}`;
  } else if (profile === PROFILES.ESTAGIARIO) {
    const b64 = Buffer.from(`estagiario:${estagiarioPassword}`, 'utf8').toString('base64');
    authorization = `Basic ${b64}`;
  } else if (profile === PROFILES.SYNC_BOT) {
    authorization = `user_token ${syncBotToken}`;
  } else {
    throw new Error(`Perfil desconhecido em login de teste: ${profile}`);
  }

  const res = await app.inject({
    method: 'GET',
    url: '/apirest.php/initSession',
    headers: {
      'App-Token': appToken,
      Authorization: authorization,
    },
  });

  assert.equal(res.statusCode, 200, `Falha ao abrir sessão de teste para ${profile}: ${res.body}`);
  const { session_token: sessionToken } = res.json();
  return {
    'App-Token': appToken,
    'Session-Token': sessionToken,
  };
}
