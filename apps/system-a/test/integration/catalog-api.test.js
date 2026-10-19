import assert from 'node:assert/strict';
import test from 'node:test';
import { PROFILES } from '../../src/auth.js';
import { buildTestServer, login } from '../helpers/session.js';

const get = (app, headers, url) => app.inject({ method: 'GET', url: `/apirest.php${url}`, headers });

test('catálogos do GLPI: categorias, locais (com e sem coordenadas) e usuários sem senha nem token', async () => {
  const app = buildTestServer();
  try {
    const headers = await login(app, PROFILES.TECNICO);

    const categories = (await get(app, headers, '/ITILCategory')).json();
    assert.ok(categories.length >= 5);
    assert.deepEqual((await get(app, headers, '/ITILCategory/2')).json(), {
      id: 2,
      name: 'Impressão',
      completename: 'Hardware > Impressão',
    });

    const office = (await get(app, headers, '/Location/1')).json();
    assert.equal(typeof office.latitude, 'number');
    const home = (await get(app, headers, '/Location/4')).json();
    assert.equal(home.latitude, null);

    const users = (await get(app, headers, '/User')).json();
    assert.deepEqual(
      users.map((u) => [u.id, u.name, u.profile]),
      [
        [1, 'tecnico', 'tecnico'],
        [2, 'estagiario', 'estagiario'],
        [3, 'sync-bot', 'sync-bot'],
      ],
    );
    for (const u of users) {
      assert.equal(u.password_hash, undefined);
      assert.equal(u.api_token_hash, undefined);
    }
    assert.equal((await get(app, headers, '/User/99')).statusCode, 404);
  } finally {
    await app.close();
  }
});

test('o sync-bot e o Estagiário leem os catálogos (mesmo direito de ler chamados)', async () => {
  const app = buildTestServer();
  try {
    for (const profile of [PROFILES.SYNC_BOT, PROFILES.ESTAGIARIO]) {
      const headers = await login(app, profile);
      assert.equal((await get(app, headers, '/User/1')).statusCode, 200);
      assert.equal((await get(app, headers, '/Location')).statusCode, 200);
    }
  } finally {
    await app.close();
  }
});

test('chamado com categoria, local ou técnico inexistente é recusado com 400 ERROR_INVALID_INPUT', async () => {
  const app = buildTestServer();
  try {
    const headers = await login(app, PROFILES.TECNICO);
    const create = (input) =>
      app.inject({ method: 'POST', url: '/apirest.php/Ticket', headers, payload: { input: { name: 'x', content: 'y', ...input } } });

    for (const input of [{ itilcategories_id: 99 }, { locations_id: 99 }, { users_id_assign: 2 }, { users_id_recipient: 99 }]) {
      const res = await create(input);
      assert.equal(res.statusCode, 400, JSON.stringify(input));
      assert.equal(res.json()[0], 'ERROR_INVALID_INPUT');
    }
    const ok = await create({ itilcategories_id: 2, locations_id: 1, users_id_assign: 1 });
    assert.equal(ok.statusCode, 201);
  } finally {
    await app.close();
  }
});

test('como no GLPI: solucionar grava solvedate, fechar grava closedate e reabrir limpa as duas', async () => {
  const instants = ['2026-10-19T13:00:00Z', '2026-10-19T13:10:00Z', '2026-10-19T13:20:00Z', '2026-10-19T13:30:00Z'];
  let i = 0;
  const app = buildTestServer({ now: () => Date.parse(instants[Math.min(i++, instants.length - 1)]) });
  try {
    const headers = await login(app, PROFILES.TECNICO);
    const put = async (id, input) =>
      (await app.inject({ method: 'PUT', url: `/apirest.php/Ticket/${id}`, headers, payload: { input } })).json();

    const created = (
      await app.inject({ method: 'POST', url: '/apirest.php/Ticket', headers, payload: { input: { name: 'Mouse', content: 'z' } } })
    ).json();
    assert.equal(created.solvedate, null);

    const solved = await put(created.id, { status: 5 });
    assert.equal(solved.solvedate, solved.date_mod);
    assert.equal(solved.closedate, null);

    const closed = await put(created.id, { status: 6 });
    assert.equal(closed.solvedate, solved.solvedate);
    assert.equal(closed.closedate, closed.date_mod);

    const reopened = await put(created.id, { status: 2 });
    assert.equal(reopened.solvedate, null);
    assert.equal(reopened.closedate, null);
  } finally {
    await app.close();
  }
});
