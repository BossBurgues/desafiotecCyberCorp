import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashToken, verifyPassword } from '../../src/auth.js';
import { TicketStore } from '../../src/store.js';

test('persiste chamado em arquivo SQLite após fechar e reabrir o banco', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-a-store-'));
  const dbPath = path.join(tmpDir, 'tickets.db');

  try {
    const store1 = new TicketStore(dbPath);
    const created = store1.insert({
      name: 'Impressora do 3º andar não imprime',
      content: '<p>Parou após queda de energia.</p>',
      status: 2,
      priority: 4,
      itilcategories_id: 3,
      locations_id: 1,
      users_id_recipient: 2,
      users_id_assign: 1,
      date: '2026-10-18 13:50:00',
      date_mod: '2026-10-18 14:03:22',
      solvedate: null,
      closedate: null,
    });
    store1.close();

    assert.equal(created.id, 1);

    const store2 = new TicketStore(dbPath);
    const loaded = store2.getById(1);
    const total = store2.count();
    store2.close();

    assert.equal(total, 1);
    assert.deepEqual(loaded, {
      id: 1,
      name: 'Impressora do 3º andar não imprime',
      content: '<p>Parou após queda de energia.</p>',
      status: 2,
      priority: 4,
      itilcategories_id: 3,
      locations_id: 1,
      users_id_recipient: 2,
      users_id_assign: 1,
      date: '2026-10-18 13:50:00',
      date_mod: '2026-10-18 14:03:22',
      solvedate: null,
      closedate: null,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('mantém atualizações e filtro por dateModGte após reabertura do arquivo SQLite', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-a-store-update-'));
  const dbPath = path.join(tmpDir, 'tickets.db');

  try {
    const store1 = new TicketStore(dbPath);
    store1.insert({
      name: 'Chamado 1',
      content: 'Original',
      status: 1,
      priority: 3,
      date: '2026-10-18 10:00:00',
      date_mod: '2026-10-18 10:00:00',
    });
    store1.insert({
      name: 'Chamado 2',
      content: 'Original 2',
      status: 1,
      priority: 3,
      date: '2026-10-18 10:05:00',
      date_mod: '2026-10-18 10:05:00',
    });
    store1.update(1, { status: 4, date_mod: '2026-10-18 10:15:00' });
    store1.close();

    const store2 = new TicketStore(dbPath);
    const filtered = store2.list({ dateModGte: '2026-10-18 10:10:00' });
    const filteredCount = store2.count({ dateModGte: '2026-10-18 10:10:00' });
    store2.close();

    assert.equal(filteredCount, 1);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, 1);
    assert.equal(filtered[0].status, 4);
    assert.equal(filtered[0].date_mod, '2026-10-18 10:15:00');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('seed é idempotente e trocar a senha no ambiente troca o login', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-a-store-seed-'));
  const dbPath = path.join(tmpDir, 'users.db');

  try {
    const store1 = new TicketStore(dbPath);
    store1.seedUsers({
      tecnicoPassword: 's1',
      estagiarioPassword: 'e1',
      syncBotToken: 'b1',
    });
    const hashBefore = store1.findUserByLogin('tecnico').password_hash;

    // Segundo seed com as mesmas credenciais não altera o hash existente
    store1.seedUsers({
      tecnicoPassword: 's1',
      estagiarioPassword: 'e1',
      syncBotToken: 'b1',
    });
    const hashSame = store1.findUserByLogin('tecnico').password_hash;
    assert.equal(hashSame, hashBefore);

    const tecnico = store1.findUserByLogin('tecnico');
    const estagiario = store1.findUserByLogin('estagiario');
    const bot = store1.findUserByLogin('sync-bot');
    assert.equal(tecnico.id, 1);
    assert.equal(estagiario.id, 2);
    assert.equal(bot.id, 3);
    assert.equal(verifyPassword('s1', tecnico.password_hash), true);
    assert.equal(bot.api_token_hash, hashToken('b1'));
    store1.close();

    // Reabre o banco mudando a senha do técnico e o token do sync-bot
    const store2 = new TicketStore(dbPath);
    store2.seedUsers({
      tecnicoPassword: 's2-nova',
      estagiarioPassword: 'e1',
      syncBotToken: 'b2-novo',
    });
    const tecnicoUpdated = store2.findUserByLogin('tecnico');
    assert.equal(verifyPassword('s1', tecnicoUpdated.password_hash), false);
    assert.equal(verifyPassword('s2-nova', tecnicoUpdated.password_hash), true);
    assert.equal(store2.findUserByApiTokenHash(hashToken('b1')), null);
    assert.equal(store2.findUserByApiTokenHash(hashToken('b2-novo')).id, 3);
    store2.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('registro de negação não pode ser alterado nem apagado', () => {
  const store = new TicketStore(':memory:');
  try {
    const inserted = store.recordDenial({
      occurred_at: '2026-10-18T17:00:00.000Z',
      status: 403,
      error_code: 'ERROR_RIGHT_MISSING',
      user_id: 2,
      login: 'estagiario',
      profile: 'estagiario',
      action: 'ticket.update',
      method: 'PUT',
      url: '/apirest.php/Ticket/1',
      ticket_id: 1,
      origin_ip: '127.0.0.1',
    });
    assert.equal(inserted.id, 1);

    assert.throws(
      () => store.db.prepare('UPDATE access_denials SET login = ? WHERE id = 1').run('outro'),
      /access_denials é append-only/,
    );
    assert.throws(
      () => store.db.prepare('DELETE FROM access_denials WHERE id = 1').run(),
      /access_denials é append-only/,
    );

    const denials = store.listDenials();
    assert.equal(denials.length, 1);
    assert.equal(denials[0].login, 'estagiario');
  } finally {
    store.close();
  }
});

