import assert from 'node:assert/strict';
import test from 'node:test';
import { PROFILES } from '../../src/auth.js';
import { buildTestServer, login } from '../helpers/session.js';

// Lixeira do GLPI (ADR-015): excluir é reversível; o chamado sai da listagem padrão e continua legível por ID.

async function createTicket(app, headers, name = 'Impressora parada') {
  const res = await app.inject({ method: 'POST', url: '/apirest.php/Ticket', headers, payload: { input: { name, content: 'x' } } });
  assert.equal(res.statusCode, 201);
  return res.json();
}

test('DELETE manda para a lixeira: some da lista padrão, aparece com is_deleted=1 e restaurar devolve', async () => {
  const events = [];
  const app = buildTestServer();
  app.emitter.on('ticket.changed', (e) => events.push(e));
  try {
    const tecnico = await login(app, PROFILES.TECNICO);
    const { id } = await createTicket(app, tecnico);
    const other = await createTicket(app, tecnico, 'Outro');
    const list = async (q = '') =>
      (await app.inject({ method: 'GET', url: `/apirest.php/Ticket${q}`, headers: tecnico })).json().map((t) => t.id);

    const del = await app.inject({ method: 'DELETE', url: `/apirest.php/Ticket/${id}`, headers: tecnico });
    assert.equal(del.statusCode, 200);
    assert.deepEqual(del.json(), [{ [id]: true, message: '' }]);
    assert.equal(events.at(-1).action, 'updated');

    assert.deepEqual(await list(), [other.id]);
    assert.deepEqual(await list('?is_deleted=1'), [id]);
    const read = (await app.inject({ method: 'GET', url: `/apirest.php/Ticket/${id}`, headers: tecnico })).json();
    assert.equal(read.is_deleted, 1);

    // Excluir de novo é idempotente: não grava nem dispara evento
    const before = events.length;
    assert.equal((await app.inject({ method: 'DELETE', url: `/apirest.php/Ticket/${id}`, headers: tecnico })).statusCode, 200);
    assert.equal(events.length, before);

    const restored = await app.inject({ method: 'PUT', url: `/apirest.php/Ticket/${id}`, headers: tecnico, payload: { input: { is_deleted: 0 } } });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().is_deleted, 0);
    assert.deepEqual((await list()).sort(), [id, other.id].sort());
  } finally {
    await app.close();
  }
});

test('na lixeira o chamado só aceita restaurar (409); notas continuam valendo', async () => {
  const app = buildTestServer();
  try {
    const tecnico = await login(app, PROFILES.TECNICO);
    const { id } = await createTicket(app, tecnico);
    await app.inject({ method: 'DELETE', url: `/apirest.php/Ticket/${id}`, headers: tecnico });

    const edit = await app.inject({ method: 'PUT', url: `/apirest.php/Ticket/${id}`, headers: tecnico, payload: { input: { name: 'novo' } } });
    assert.equal(edit.statusCode, 409);
    assert.equal(edit.json()[0], 'ERROR_TICKET_DELETED');

    const note = await app.inject({
      method: 'POST',
      url: '/apirest.php/ITILFollowup',
      headers: tecnico,
      payload: { input: { itemtype: 'Ticket', items_id: id, content: 'Excluído por engano?' } },
    });
    assert.equal(note.statusCode, 201);
  } finally {
    await app.close();
  }
});

test('Estagiário não exclui (403); sync-bot exclui e restaura, mas não edita outros campos', async () => {
  const app = buildTestServer();
  try {
    const tecnico = await login(app, PROFILES.TECNICO);
    const estagiario = await login(app, PROFILES.ESTAGIARIO);
    const bot = await login(app, PROFILES.SYNC_BOT);
    const { id } = await createTicket(app, tecnico);

    assert.equal((await app.inject({ method: 'DELETE', url: `/apirest.php/Ticket/${id}`, headers: estagiario })).statusCode, 403);
    assert.equal((await app.inject({ method: 'DELETE', url: `/apirest.php/Ticket/${id}`, headers: bot })).statusCode, 200);
    const put = (input) => app.inject({ method: 'PUT', url: `/apirest.php/Ticket/${id}`, headers: bot, payload: { input } });
    assert.equal((await put({ is_deleted: 0, name: 'x' })).statusCode, 403);
    assert.equal((await put({ is_deleted: 0 })).statusCode, 200);
    assert.equal((await app.inject({ method: 'DELETE', url: '/apirest.php/Ticket/999', headers: tecnico })).statusCode, 404);
  } finally {
    await app.close();
  }
});

test('chamado novo não nasce na lixeira e is_deleted só aceita 0 ou 1', async () => {
  const app = buildTestServer();
  try {
    const tecnico = await login(app, PROFILES.TECNICO);
    const created = await app.inject({
      method: 'POST',
      url: '/apirest.php/Ticket',
      headers: tecnico,
      payload: { input: { name: 'x', content: 'y', is_deleted: 1 } },
    });
    assert.equal(created.statusCode, 400);
    const { id } = await createTicket(app, tecnico);
    const bad = await app.inject({ method: 'PUT', url: `/apirest.php/Ticket/${id}`, headers: tecnico, payload: { input: { is_deleted: 2 } } });
    assert.equal(bad.statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/apirest.php/Ticket?is_deleted=x', headers: tecnico })).statusCode, 400);
  } finally {
    await app.close();
  }
});
