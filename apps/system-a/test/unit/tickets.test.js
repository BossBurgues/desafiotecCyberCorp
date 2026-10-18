import assert from 'node:assert/strict';
import test from 'node:test';
import { TicketValidationError, validateTicketInput } from '../../src/tickets.js';

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
