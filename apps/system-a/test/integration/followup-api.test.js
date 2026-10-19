import assert from 'node:assert/strict';
import test from 'node:test';
import { PROFILES } from '../../src/auth.js';
import { buildTestServer, login } from '../helpers/session.js';

test('acompanhamentos: o Técnico e o sync-bot escrevem notas; a conversa sai em ordem, com o autor', async () => {
  const app = buildTestServer();
  try {
    const tecnico = await login(app, PROFILES.TECNICO);
    const bot = await login(app, PROFILES.SYNC_BOT);
    const { id } = (
      await app.inject({ method: 'POST', url: '/apirest.php/Ticket', headers: tecnico, payload: { input: { name: 'x', content: 'y' } } })
    ).json();

    const note = (headers, content) =>
      app.inject({ method: 'POST', url: '/apirest.php/ITILFollowup', headers, payload: { input: { itemtype: 'Ticket', items_id: id, content } } });

    const first = await note(tecnico, 'Verifiquei o cabo.');
    assert.equal(first.statusCode, 201);
    assert.equal(first.json().users_id, 1);
    assert.equal((await note(bot, 'Fechado no Sistema B. ⟦from-b:B-1⟧')).statusCode, 201);

    const list = (await app.inject({ method: 'GET', url: `/apirest.php/Ticket/${id}/ITILFollowup`, headers: tecnico })).json();
    assert.deepEqual(
      list.map((f) => [f.users_id, f.itemtype, f.is_private]),
      [
        [1, 'Ticket', 0],
        [3, 'Ticket', 0],
      ],
    );
  } finally {
    await app.close();
  }
});

test('acompanhamento: Estagiário recebe 403, chamado inexistente 404 e entrada inválida 400', async () => {
  const app = buildTestServer();
  try {
    const estagiario = await login(app, PROFILES.ESTAGIARIO);
    const tecnico = await login(app, PROFILES.TECNICO);
    const post = (headers, input) => app.inject({ method: 'POST', url: '/apirest.php/ITILFollowup', headers, payload: { input } });

    assert.equal((await post(estagiario, { itemtype: 'Ticket', items_id: 1, content: 'x' })).statusCode, 403);
    assert.equal((await post(tecnico, { itemtype: 'Ticket', items_id: 99, content: 'x' })).statusCode, 404);
    assert.equal((await post(tecnico, { itemtype: 'Ticket', items_id: 1, content: '' })).statusCode, 400);
    assert.equal((await post(tecnico, { itemtype: 'Problem', items_id: 1, content: 'x' })).statusCode, 400);
  } finally {
    await app.close();
  }
});
