import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTimeline,
  describeNote,
  initials,
  matchesSearch,
  shortDate,
  canAct,
  canAddNote,
  editableStatuses,
  userLabel,
  catalogLabel,
  errorMessage,
  htmlToText,
  priorityLabel,
  statusLabel,
  solutionNote,
  stripMarkers,
  ticketActions,
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

test('o Técnico pode escolher todos os status do GLPI, inclusive Solucionado e Fechado', () => {
  assert.deepEqual(editableStatuses(), [1, 2, 3, 4, 5, 6]);
});

test('todos os status e prioridades 1–6 têm rótulo', () => {
  for (let i = 1; i <= 6; i++) {
    assert.doesNotMatch(statusLabel(i), /^Status /);
    assert.doesNotMatch(priorityLabel(i), /^Prioridade /);
  }
});

test('rótulos dos catálogos: nome completo do usuário com o login, e "—" sem valor', () => {
  assert.equal(userLabel({ name: 'tecnico', firstname: 'Ana', realname: 'Souza' }), 'Ana Souza (tecnico)');
  assert.equal(userLabel({ name: 'sync-bot', firstname: '', realname: '' }), 'sync-bot');
  assert.equal(userLabel(undefined), '—');
  const cats = [{ id: 2, name: 'Impressão', completename: 'Hardware > Impressão' }];
  assert.equal(catalogLabel(cats, 2), 'Hardware > Impressão');
  assert.equal(catalogLabel(cats, null), '—');
  assert.equal(catalogLabel(cats, 9), '—');
});

test('ações do chamado: só o Técnico age, e cada ação vale só no status certo (regra da UI do B)', () => {
  assert.equal(canAct('tecnico'), true);
  assert.equal(canAct('estagiario'), false);
  const enabled = (ticket) =>
    ticketActions({ users_id_assign: null, is_deleted: 0, ...ticket }, 1)
      .filter((a) => a.enabled)
      .map((a) => a.id);
  assert.deepEqual(enabled({ status: 1 }), ['assign', 'progress', 'pending', 'solve', 'close', 'delete']);
  assert.deepEqual(enabled({ status: 2, users_id_assign: 1 }), ['pending', 'solve', 'close', 'delete']);
  assert.deepEqual(enabled({ status: 4 }), ['assign', 'progress', 'solve', 'close', 'delete']);
  assert.deepEqual(enabled({ status: 5 }), ['close', 'reopen', 'delete']);
  assert.deepEqual(enabled({ status: 6 }), ['reopen', 'delete']);
  assert.deepEqual(enabled({ status: 2, is_deleted: 1 }), ['restore']);
});

test('ações do chamado: o PUT de cada uma (atribuir põe em atendimento se estava Novo; reabrir volta a 2)', () => {
  const byId = (status) => Object.fromEntries(ticketActions({ status, users_id_assign: null, is_deleted: 0 }, 1).map((a) => [a.id, a.input]));
  assert.deepEqual(byId(1).assign, { users_id_assign: 1, status: 2 });
  assert.deepEqual(byId(4).assign, { users_id_assign: 1 });
  assert.deepEqual(byId(2).solve, { status: 5 });
  assert.deepEqual(byId(5).close, { status: 6 });
  assert.deepEqual(byId(6).reopen, { status: 2 });
  assert.deepEqual(byId(2).restore, { is_deleted: 0 });
  assert.equal(byId(2).delete, undefined);
  assert.equal(solutionNote('  Troquei o toner. '), 'Solução: Troquei o toner.');
});

test('só o Técnico adiciona nota', () => {
  assert.equal(canAddNote('tecnico'), true);
  assert.equal(canAddNote('estagiario'), false);
});

test('409 ERROR_TICKET_DELETED pede para restaurar antes de editar', () => {
  assert.match(errorMessage({ status: 409, code: 'ERROR_TICKET_DELETED', message: 'x' }), /lixeira: restaure/);
});

const USERS = [
  { id: 1, name: 'tecnico', firstname: 'Ana', realname: 'Souza', profile: 'tecnico' },
  { id: 2, name: 'estagiario', firstname: 'Bruno', realname: 'Lima', profile: 'estagiario' },
];

test('histórico: a nota do B vira evento "Estado alterado no B" com o operador como autor e a solução separada', () => {
  const note = describeNote(
    {
      users_id: 3,
      date: '2026-10-19 18:57:47',
      content: 'Estado alterado no Sistema B por Carla (suporte): Em andamento → Fechado. Solução: Toner trocado. ⟦from-b:B-91⟧',
    },
    USERS,
  );
  assert.deepEqual(note.author, { kind: 'operador', name: 'Carla (suporte)', role: 'Sistema B' });
  assert.equal(note.when, '19/10 · 18:57');
  assert.deepEqual(note.events, [
    { type: 'state', tag: 'Estado alterado no B', who: 'Carla (suporte)', text: 'Em andamento → Fechado', quote: 'Toner trocado.' },
  ]);
});

test('histórico: uma nota do sync com várias frases vira vários eventos, um por linha', () => {
  const note = describeNote({
    users_id: 3,
    date: '2026-10-19 18:00:00',
    content:
      'O Sistema B também mudou o estado para Resolvido (por Diego), ao mesmo tempo que o A mudou para Em espera: prevaleceu o A.\n' +
      'O Sistema B alterou o título, a descrição (por Diego); o A é a fonte da verdade e o valor foi restaurado. ⟦from-b:B-7⟧',
  });
  assert.equal(note.author.name, 'Diego');
  assert.deepEqual(
    note.events.map((e) => [e.type, e.tag]),
    [
      ['conflict', 'Conflito: o A venceu'],
      ['reverted', 'Edição desfeita'],
    ],
  );
  assert.match(note.events[1].text, /^Mudou o título, a descrição no B/);
});

test('histórico: exclusões vindas do B e frase desconhecida', () => {
  const trashed = describeNote({
    users_id: 3,
    date: '2026-10-19 18:00:00',
    content: 'Excluído no Sistema B por Maria em 2026-10-19 14:30:00: o chamado foi para a lixeira do A (restaurar recria o registro no B). ⟦from-b:B-7⟧',
  });
  assert.deepEqual([trashed.author.name, trashed.events[0].tag], ['Maria', 'Excluído no B']);
  const won = describeNote({
    users_id: 3,
    date: '2026-10-19 18:00:00',
    content: 'O Sistema B excluiu o registro B-7 (por Maria em 2026-10-19 14:30:00), mas o chamado mudou no A depois da última sincronização: prevaleceu o A e o registro foi recriado no B. ⟦from-b:B-7⟧',
  });
  assert.equal(won.events[0].tag, 'Exclusão no B desfeita');
  const other = describeNote({ users_id: 3, date: '2026-10-19 18:00:00', content: 'Sincronizado ⟦n:abc⟧' });
  assert.deepEqual(other.author, { kind: 'sync', name: 'Sincronizador', role: 'automático' });
  assert.deepEqual(other.events, [{ type: 'note', tag: null, who: null, text: 'Sincronizado' }]);
});

test('histórico: nota de pessoa leva o nome do catálogo; "Solução: …" vira evento de solução', () => {
  const solution = describeNote({ users_id: 1, date: '2026-10-19 18:46:46', content: 'Solução: cabo trocado.', is_private: 0 }, USERS);
  assert.deepEqual(solution.author, { kind: 'tecnico', name: 'Ana Souza', role: 'Técnico' });
  assert.deepEqual(solution.events, [{ type: 'solution', tag: 'Solução', who: null, text: 'cabo trocado.' }]);
  const note = describeNote({ users_id: 2, date: '2026-10-19 18:46:46', content: 'Linha 1\nLinha 2' }, USERS);
  assert.deepEqual([note.author.role, note.events.length, note.events[0].text], ['Estagiário', 1, 'Linha 1\nLinha 2']);
});

test('histórico em ordem de data, o mais antigo primeiro', () => {
  const items = buildTimeline(
    [
      { users_id: 1, content: 'segunda', date: '2026-10-18 14:00:00' },
      { users_id: 1, content: 'primeira', date: '2026-10-18 13:00:00' },
    ],
    USERS,
  );
  assert.deepEqual(items.map((i) => i.events[0].text), ['primeira', 'segunda']);
});

test('busca da lista por número ou trecho do título, sem acento nem caixa; datas e iniciais curtas', () => {
  const t = { id: 90, name: 'G2 Monitor piscando na recepção' };
  assert.equal(matchesSearch(t, ''), true);
  assert.equal(matchesSearch(t, '#90'), true);
  assert.equal(matchesSearch(t, 'RECEPCAO'), true);
  assert.equal(matchesSearch(t, '9'), false);
  assert.equal(shortDate('2026-10-19 18:57:27'), '19/10 · 18:57');
  assert.equal(initials('Ana Souza'), 'AS');
  assert.equal(initials('Carla (suporte)'), 'C');
});

test('ações: o próximo passo natural é o principal', () => {
  const primary = (ticket) =>
    ticketActions({ users_id_assign: null, is_deleted: 0, ...ticket }, 1).find((a) => a.primary)?.id;
  assert.equal(primary({ status: 1 }), 'assign');
  assert.equal(primary({ status: 2, users_id_assign: 1 }), 'solve');
  assert.equal(primary({ status: 5 }), 'close');
  assert.equal(primary({ status: 6 }), 'reopen');
  assert.equal(primary({ status: 2, is_deleted: 1 }), 'restore');
});
