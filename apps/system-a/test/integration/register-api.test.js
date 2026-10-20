import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTestServer, TEST_AUTH_CONFIG } from '../helpers/session.js';

// Cadastro pela tela de login: cria Estagiário. Técnico só com A_SELF_REGISTER_TECNICO=true (uso local).

const register = (app, input, appToken = TEST_AUTH_CONFIG.uiAppToken) =>
  app.inject({ method: 'POST', url: '/apirest.php/register', headers: { 'App-Token': appToken }, payload: { input } });

const login = (app, user, password) =>
  app.inject({
    method: 'GET',
    url: '/apirest.php/initSession',
    headers: {
      'App-Token': TEST_AUTH_CONFIG.uiAppToken,
      Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
    },
  });

test('com a flag local, cadastro cria Técnico, sem sessão, e ele entra com a senha', async () => {
  const app = buildTestServer({ selfRegisterTecnico: true });
  try {
    const res = await register(app, { name: 'Carla.Dias', firstname: ' Carla ', realname: 'Dias', password: 'senha-forte-1', profile: 'tecnico' });
    assert.equal(res.statusCode, 201);
    const user = res.json();
    assert.deepEqual(user, { id: user.id, name: 'carla.dias', firstname: 'Carla', realname: 'Dias', profile: 'tecnico' });
    assert.ok(user.id > 3, 'os IDs 1–3 são do seed');
    assert.doesNotMatch(res.body, /password|hash|token/i);

    const session = await login(app, 'carla.dias', 'senha-forte-1');
    assert.equal(session.statusCode, 200);
    const headers = { 'App-Token': TEST_AUTH_CONFIG.uiAppToken, 'Session-Token': session.json().session_token };
    const full = (await app.inject({ method: 'GET', url: '/apirest.php/getFullSession', headers })).json();
    assert.equal(full.session.glpiactiveprofile.name, 'tecnico');

    // O novo Técnico pode ser atribuído e aparece no catálogo com o nome
    const users = (await app.inject({ method: 'GET', url: '/apirest.php/User', headers })).json();
    assert.ok(users.some((u) => u.id === user.id && u.firstname === 'Carla'));
    const created = await app.inject({
      method: 'POST',
      url: '/apirest.php/Ticket',
      headers,
      payload: { input: { name: 'x', content: 'y', users_id_assign: user.id } },
    });
    assert.equal(created.statusCode, 201);
  } finally {
    await app.close();
  }
});

test('Estagiário cadastrado entra e continua sem poder editar (403)', async () => {
  const app = buildTestServer();
  try {
    assert.equal((await register(app, { name: 'dani', firstname: 'Dani', realname: '', password: 'senha-forte-2', profile: 'estagiario' })).statusCode, 201);
    const session = await login(app, 'dani', 'senha-forte-2');
    const headers = { 'App-Token': TEST_AUTH_CONFIG.uiAppToken, 'Session-Token': session.json().session_token };
    const t = await app.inject({ method: 'POST', url: '/apirest.php/Ticket', headers, payload: { input: { name: 'x', content: 'y' } } });
    assert.equal(t.statusCode, 201);
    const put = await app.inject({ method: 'PUT', url: `/apirest.php/Ticket/${t.json().id}`, headers, payload: { input: { name: 'z' } } });
    assert.equal(put.statusCode, 403);
  } finally {
    await app.close();
  }
});

test('cadastro recusa login repetido (409), nível sync-bot, dados inválidos (400) e falta de App-Token (401)', async () => {
  const app = buildTestServer();
  try {
    const ok = { name: 'eva', firstname: 'Eva', realname: 'Rocha', password: 'senha-forte-3', profile: 'estagiario' };
    assert.equal((await register(app, ok)).statusCode, 201);
    const taken = await register(app, { ...ok, name: 'EVA' });
    assert.equal(taken.statusCode, 409);
    assert.equal(taken.json()[0], 'ERROR_LOGIN_TAKEN');
    assert.equal((await register(app, { ...ok, name: 'tecnico' })).statusCode, 409);

    for (const bad of [
      { ...ok, name: 'outro', profile: 'sync-bot' },
      { ...ok, name: 'outro', password: 'curta' },
      { ...ok, name: 'a b' },
      { ...ok, name: 'outro', firstname: '' },
      { ...ok, name: 'outro', extra: 1 },
    ]) {
      assert.equal((await register(app, bad)).statusCode, 400, JSON.stringify(bad));
    }
    assert.equal((await register(app, { ...ok, name: 'outro' }, 'errado')).statusCode, 401);
  } finally {
    await app.close();
  }
});

test('sem a flag, cadastro de Técnico é recusado (403), a UI não oferece e sem nível vira Estagiário', async () => {
  const app = buildTestServer();
  try {
    const res = await register(app, { name: 'mal', firstname: 'Mal', realname: '', password: 'senha-forte-4', profile: 'tecnico' });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json()[0], 'ERROR_RIGHT_MISSING');
    const config = (await app.inject({ method: 'GET', url: '/ui/config.json' })).json();
    assert.equal(config.selfRegisterTecnico, false);

    const plain = await register(app, { name: 'leo', firstname: 'Leo', realname: '', password: 'senha-forte-5' });
    assert.equal(plain.statusCode, 201);
    assert.equal(plain.json().profile, 'estagiario');
  } finally {
    await app.close();
  }
});

test('cadastro limita tentativas por endereço (429) e libera depois da janela', async () => {
  let clock = Date.parse('2026-10-20T12:00:00Z');
  const app = buildTestServer({ now: () => clock });
  try {
    const attempt = (i) => register(app, { name: `pessoa${i}`, firstname: 'U', realname: '', password: 'senha-forte-6', profile: 'estagiario' });
    for (let i = 0; i < 10; i += 1) assert.equal((await attempt(i)).statusCode, 201);
    const limited = await attempt(10);
    assert.equal(limited.statusCode, 429);
    clock += 10 * 60_000 + 1;
    assert.equal((await attempt(11)).statusCode, 201);
  } finally {
    await app.close();
  }
});
