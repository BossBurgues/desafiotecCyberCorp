import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TicketValidationError,
  formatLocalDateTime,
  isGlpiDateTime,
  parseListQuery,
  prepareNewTicket,
  touch,
  validateTicketInput,
} from '../../src/tickets.js';

test('aceita chamado válido na criação aplicando defaults de status 1 e prioridade 3', () => {
  const result = validateTicketInput({
    name: 'Impressora não imprime',
    content: '<p>Parou após queda de energia</p>',
  });

  assert.deepEqual(result, {
    name: 'Impressora não imprime',
    content: '<p>Parou após queda de energia</p>',
    status: 1,
    priority: 3,
    itilcategories_id: null,
    locations_id: null,
    users_id_recipient: null,
    users_id_assign: null,
    solvedate: null,
    closedate: null,
  });
});

test('aceita status e prioridade nos limites 1 e 6', () => {
  const min = validateTicketInput({
    name: 'Chamado mínimo',
    content: 'Texto',
    status: 1,
    priority: 1,
  });
  const max = validateTicketInput({
    name: 'Chamado máximo',
    content: 'Texto',
    status: 6,
    priority: 6,
  });

  assert.equal(min.status, 1);
  assert.equal(min.priority, 1);
  assert.equal(max.status, 6);
  assert.equal(max.priority, 6);
});

test('rejeita status 0 e 7 fora do intervalo 1–6', () => {
  assert.throws(
    () => validateTicketInput({ name: 'Teste', content: 'Texto', status: 0 }),
    TicketValidationError,
  );
  assert.throws(
    () => validateTicketInput({ name: 'Teste', content: 'Texto', status: 7 }),
    TicketValidationError,
  );
});

test('rejeita prioridade fora do intervalo 1–6', () => {
  assert.throws(
    () => validateTicketInput({ name: 'Teste', content: 'Texto', priority: 0 }),
    TicketValidationError,
  );
  assert.throws(
    () => validateTicketInput({ name: 'Teste', content: 'Texto', priority: 7 }),
    TicketValidationError,
  );
});

test('rejeita campo desconhecido ou gerado pelo servidor como date_mod no input', () => {
  assert.throws(
    () =>
      validateTicketInput({
        name: 'Teste',
        content: 'Texto',
        date_mod: '2026-10-18 14:00:00',
      }),
    TicketValidationError,
  );
  assert.throws(
    () =>
      validateTicketInput({
        name: 'Teste',
        content: 'Texto',
        id: 10,
      }),
    TicketValidationError,
  );
});

test('rejeita name vazio ou acima de 255 caracteres', () => {
  assert.throws(
    () => validateTicketInput({ name: '', content: 'Texto' }),
    TicketValidationError,
  );
  assert.throws(
    () => validateTicketInput({ name: 'a'.repeat(256), content: 'Texto' }),
    TicketValidationError,
  );
});

test('aceita atualização parcial mantendo apenas os campos enviados', () => {
  const patch = validateTicketInput({ status: 2, priority: 5 }, { partial: true });
  assert.deepEqual(patch, { status: 2, priority: 5 });
});

test('formata o mesmo instante com strings diferentes em America/Sao_Paulo e em UTC sem offset', () => {
  const instant = Date.parse('2026-10-18T17:03:22Z');
  const sp = formatLocalDateTime(instant, 'America/Sao_Paulo');
  const utc = formatLocalDateTime(instant, 'UTC');

  assert.equal(sp, '2026-10-18 14:03:22');
  assert.equal(utc, '2026-10-18 17:03:22');
  assert.ok(isGlpiDateTime(sp));
  assert.ok(!sp.includes('Z') && !sp.includes('+') && !sp.includes('T'));
});

test('vira 23:59:59 para 00:00:00 do dia seguinte no fuso configurado', () => {
  const beforeMidnightSp = Date.parse('2026-10-19T02:59:59Z');
  const atMidnightSp = Date.parse('2026-10-19T03:00:00Z');

  assert.equal(formatLocalDateTime(beforeMidnightSp, 'America/Sao_Paulo'), '2026-10-18 23:59:59');
  assert.equal(formatLocalDateTime(atMidnightSp, 'America/Sao_Paulo'), '2026-10-19 00:00:00');
});

test('touch atualiza date_mod a partir do relógio injetado', () => {
  const ticket = { id: 1, date_mod: '2026-10-18 10:00:00' };
  touch(ticket, () => Date.parse('2026-10-18T18:30:05Z'), 'America/Sao_Paulo');

  assert.equal(ticket.date_mod, '2026-10-18 15:30:05');
});

test('parseListQuery valida range, sort, order e date_mod_gte', () => {
  assert.deepEqual(parseListQuery({}), {
    offset: 0,
    start: 0,
    end: 49,
    limit: 50,
    sort: 'date_mod',
    order: 'ASC',
    dateModGte: null,
    isDeleted: 0,
  });

  assert.throws(() => parseListQuery({ range: '50-10' }), TicketValidationError);
  assert.throws(() => parseListQuery({ range: '0-500' }), TicketValidationError);
  assert.throws(() => parseListQuery({ sort: 'name' }), TicketValidationError);
  assert.throws(() => parseListQuery({ order: 'RANDOM' }), TicketValidationError);
  assert.throws(
    () => parseListQuery({ date_mod_gte: '2026-10-18T10:00:00Z' }),
    TicketValidationError,
  );
});

test('valida metadados de anexos com sha256 em hex de 64 caracteres', () => {
  const validSha = 'a'.repeat(64);
  const res = validateTicketInput({
    name: 'Com anexo',
    content: 'Texto',
    attachments: [{ name: 'log.txt', size: 128, sha256: validSha }],
  });
  assert.equal(res.attachments.length, 1);

  assert.throws(
    () =>
      validateTicketInput({
        name: 'Anexo inválido',
        content: 'Texto',
        attachments: [{ name: 'log.txt', size: 128, sha256: 'curto' }],
      }),
    TicketValidationError,
  );
});

test('prepareNewTicket assume defaultRecipientId quando users_id_recipient não é enviado e preserva quando enviado', () => {
  const withDefault = prepareNewTicket(
    { input: { name: 'Aberto pelo estagiário', content: 'Texto' } },
    { defaultRecipientId: 2, now: () => Date.parse('2026-10-18T17:00:00Z') },
  );
  assert.equal(withDefault.users_id_recipient, 2);

  const explicit = prepareNewTicket(
    { input: { name: 'Em nome de outro', content: 'Texto', users_id_recipient: 9 } },
    { defaultRecipientId: 2, now: () => Date.parse('2026-10-18T17:00:00Z') },
  );
  assert.equal(explicit.users_id_recipient, 9);

  const explicitNull = prepareNewTicket(
    { input: { name: 'Sem requerente', content: 'Texto', users_id_recipient: null } },
    { defaultRecipientId: 2, now: () => Date.parse('2026-10-18T17:00:00Z') },
  );
  assert.equal(explicitNull.users_id_recipient, null);
});
