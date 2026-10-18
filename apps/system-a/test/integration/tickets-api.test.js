import assert from 'node:assert/strict';
import test from 'node:test';
import { buildServer } from '../../src/server.js';
import { glpiError } from '../../src/tickets.js';

test('glpiError formata erro como tupla [codigo, mensagem] de duas strings', async () => {
  assert.deepEqual(glpiError('ERROR_INVALID_INPUT', 'Campo inválido.'), [
    'ERROR_INVALID_INPUT',
    'Campo inválido.',
  ]);

  const app = buildServer({ dbPath: ':memory:' });
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/apirest.php/RotaInexistente',
    });

    assert.equal(res.statusCode, 404);
    const body = res.json();
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 2);
    assert.equal(body[0], 'ERROR_ITEM_NOT_FOUND');
    assert.equal(typeof body[1], 'string');
  } finally {
    await app.close();
  }
});

test('POST /apirest.php/Ticket cria chamado (201) e GET /apirest.php/Ticket/:id lê de volta (200)', async () => {
  const app = buildServer({
    dbPath: ':memory:',
    timeZone: 'America/Sao_Paulo',
    now: () => Date.parse('2026-10-18T17:03:22Z'),
  });

  try {
    const createRes = await app.inject({
      method: 'POST',
      url: '/apirest.php/Ticket',
      payload: {
        input: {
          name: 'Impressora do 3º andar não imprime',
          content: '<p>Parou após queda de energia.</p>',
          status: 2,
          priority: 4,
          itilcategories_id: 3,
          locations_id: 1,
          users_id_recipient: 2,
          users_id_assign: 1,
        },
      },
    });

    assert.equal(createRes.statusCode, 201);
    const created = createRes.json();
    assert.deepEqual(created, {
      id: 1,
      name: 'Impressora do 3º andar não imprime',
      content: '<p>Parou após queda de energia.</p>',
      status: 2,
      priority: 4,
      itilcategories_id: 3,
      locations_id: 1,
      users_id_recipient: 2,
      users_id_assign: 1,
      date: '2026-10-18 14:03:22',
      date_mod: '2026-10-18 14:03:22',
      solvedate: null,
      closedate: null,
    });

    const getRes = await app.inject({
      method: 'GET',
      url: '/apirest.php/Ticket/1',
    });

    assert.equal(getRes.statusCode, 200);
    assert.deepEqual(getRes.json(), created);

    const notFoundRes = await app.inject({
      method: 'GET',
      url: '/apirest.php/Ticket/999',
    });

    assert.equal(notFoundRes.statusCode, 404);
    assert.equal(notFoundRes.json()[0], 'ERROR_ITEM_NOT_FOUND');
  } finally {
    await app.close();
  }
});
