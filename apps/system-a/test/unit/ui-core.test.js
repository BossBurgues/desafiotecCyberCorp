import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorOf,
  buildTimeline,
  canAddNote,
  canDecide,
  editableStatuses,
  errorMessage,
  htmlToText,
  priorityLabel,
  statusLabel,
  stripMarkers,
} from '../../src/public/ui-core.js';

test('403 do Estagiário vira frase que cita o perfil e a ação', () => {
  const msg = errorMessage({
    status: 403,
    code: 'ERROR_RIGHT_MISSING',
    message: 'Perfil estagiario não pode executar ticket.update.',
    profile: 'estagiario',
    action: 'editar chamados',
  });
  assert.equal(msg, 'Seu perfil (Estagiário) não pode editar chamados. Peça a um Técnico.');
});

test('409 ERROR_TICKET_FROZEN diz que só aceita notas e que nada foi salvo', () => {
  const msg = errorMessage({ status: 409, code: 'ERROR_TICKET_FROZEN', message: 'x' });
  assert.match(msg, /só aceita notas/);
  assert.match(msg, /não foi salva/);
});

test('sessão expirada, login errado, 400 e falha de rede têm frase própria', () => {
  assert.equal(errorMessage({ status: 401, code: 'ERROR_SESSION_TOKEN_INVALID' }), 'Sua sessão expirou. Entre de novo.');
  assert.equal(errorMessage({ status: 401, code: 'ERROR_GLPI_LOGIN' }), 'Usuário ou senha incorretos.');
  assert.equal(
    errorMessage({ status: 400, code: 'ERROR_INVALID_INPUT', message: 'O campo name é obrigatório.' }),
    'O campo name é obrigatório.',
  );
  assert.match(errorMessage({ status: 0, code: 'NETWORK' }), /Sistema A fora do ar/);
});

test('código desconhecido mostra a mensagem do servidor e o código', () => {
  const msg = errorMessage({ status: 500, code: 'ERROR_INTERNAL', message: 'Banco caiu.' });
  assert.equal(msg, 'Banco caiu. (ERROR_INTERNAL)');
});

test('nota do sync-bot com ⟦from-b:…⟧ é do Operador B 🏢, sem marcador vira 🤖', () => {
  assert.deepEqual(authorOf({ users_id: 3, content: 'Peça trocada ⟦from-b:rec-9:c-1⟧' }), {
    icon: '🏢',
    label: 'Operador B',
  });
  assert.deepEqual(authorOf({ users_id: 3, content: 'Sincronizado ⟦n:abc⟧' }), {
    icon: '🤖',
    label: 'sync-bot',
  });
});

test('nota do Técnico e do Estagiário aparece com 👤', () => {
  assert.deepEqual(authorOf({ users_id: 1, content: 'ok' }), { icon: '👤', label: 'Técnico' });
  assert.deepEqual(authorOf({ users_id: 2, content: 'ok' }), { icon: '👤', label: 'Estagiário' });
});

test('marcadores ⟦n:…⟧ e ⟦from-b:…⟧ não aparecem no texto exibido', () => {
  assert.equal(stripMarkers('Troquei o toner ⟦from-b:rec-9:c-1⟧'), 'Troquei o toner');
  assert.equal(stripMarkers('⟦n:42-1⟧ Nota do A'), 'Nota do A');
  assert.doesNotMatch(stripMarkers('a ⟦s:glpi-42⟧ b ⟦n:x⟧'), /⟦|⟧/);
});

test('htmlToText remove <script> com o conteúdo e não devolve tag nenhuma', () => {
  const out = htmlToText(
    '<p>Impressora &amp; toner</p><script>alert(1)</script><img src=x onerror=alert(1)><style>p{}</style>fim',
  );
  assert.equal(out, 'Impressora & toner\nfim');
  assert.doesNotMatch(out, /alert|<[a-z]/i);
  assert.equal(htmlToText('<script>alert(1)'), '');
  assert.equal(htmlToText('&lt;b&gt; &quot;x&quot; &#39;y&#39;'), '<b> "x" \'y\'');
});

test('só o Técnico pode aprovar, recusar e adicionar nota', () => {
  assert.equal(canDecide('tecnico'), true);
  assert.equal(canDecide('estagiario'), false);
  assert.equal(canDecide('sync-bot'), false);
  assert.equal(canAddNote('tecnico'), true);
  assert.equal(canAddNote('estagiario'), false);
});

test('o Técnico pode escolher todos os status do GLPI, inclusive Solucionado e Fechado', () => {
  assert.deepEqual(editableStatuses(), [1, 2, 3, 4, 5, 6]);
});

test('todos os status e prioridades 1–6 têm rótulo', () => {
  for (let i = 1; i <= 6; i++) {
    assert.doesNotMatch(statusLabel(i), /^Status /);
    assert.doesNotMatch(priorityLabel(i), /^Prioridade /);
  }
});

test('timeline junta notas e soluções em ordem de data, com a decisão como evento', () => {
  const items = buildTimeline(
    [
      { users_id: 1, content: 'segunda', date: '2026-10-18 14:00:00', is_private: 0 },
      { users_id: 3, content: 'primeira ⟦from-b:r:c⟧', date: '2026-10-18 13:00:00', is_private: 0 },
    ],
    [
      {
        id: 1,
        users_id: 3,
        content: 'Resolvido no B',
        status: 4,
        date_creation: '2026-10-18 13:30:00',
        users_id_approval: 1,
        date_approval: '2026-10-18 15:00:00',
      },
    ],
  );
  assert.deepEqual(
    items.map((i) => [i.kind, i.text]),
    [
      ['note', 'primeira'],
      ['solution', 'Resolvido no B'],
      ['note', 'segunda'],
      ['decision', 'Solução recusada.'],
    ],
  );
  assert.equal(items[0].author.icon, '🏢');
});
