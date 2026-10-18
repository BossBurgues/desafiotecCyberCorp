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

test('listagem pagina 120 chamados em 0-49, 50-99 e 100-149 sem repetir nem pular em ordem estável', async () => {
  // Múltiplos chamados no mesmo segundo testam o desempate por id em ORDER BY date_mod, id.
  let counter = 0;
  const baseEpoch = Date.parse('2026-10-18T15:00:00Z');
  const app = buildServer({
    dbPath: ':memory:',
    timeZone: 'America/Sao_Paulo',
    now: () => {
      const offsetSeconds = Math.floor(counter / 4);
      counter += 1;
      return baseEpoch + offsetSeconds * 1000;
    },
  });

  try {
    for (let i = 1; i <= 120; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/apirest.php/Ticket',
        payload: {
          input: {
            name: `Chamado #${i}`,
            content: `<p>Descrição ${i}</p>`,
          },
        },
      });
      assert.equal(res.statusCode, 201);
    }

    const page1 = await app.inject({
      method: 'GET',
      url: '/apirest.php/Ticket?range=0-49&sort=date_mod&order=ASC',
    });
    assert.equal(page1.statusCode, 206);
    assert.equal(page1.headers['content-range'], '0-49/120');
    const items1 = page1.json();
    assert.equal(items1.length, 50);

    const page2 = await app.inject({
      method: 'GET',
      url: '/apirest.php/Ticket?range=50-99&sort=date_mod&order=ASC',
    });
    assert.equal(page2.statusCode, 206);
    assert.equal(page2.headers['content-range'], '50-99/120');
    const items2 = page2.json();
    assert.equal(items2.length, 50);

    const page3 = await app.inject({
      method: 'GET',
      url: '/apirest.php/Ticket?range=100-149&sort=date_mod&order=ASC',
    });
    assert.equal(page3.statusCode, 206);
    assert.equal(page3.headers['content-range'], '100-119/120');
    const items3 = page3.json();
    assert.equal(items3.length, 20);

    const allIds = [...items1, ...items2, ...items3].map((t) => t.id);
    const expectedIds = Array.from({ length: 120 }, (_, idx) => idx + 1);
    assert.deepEqual(allIds, expectedIds);

    const outOfBounds = await app.inject({
      method: 'GET',
      url: '/apirest.php/Ticket?range=150-199',
    });
    assert.equal(outOfBounds.statusCode, 200);
    assert.equal(outOfBounds.headers['content-range'], '*/120');
    assert.deepEqual(outOfBounds.json(), []);
  } finally {
    await app.close();
  }
});
