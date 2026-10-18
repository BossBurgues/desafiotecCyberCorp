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
