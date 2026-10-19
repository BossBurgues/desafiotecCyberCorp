// UI do Sistema A: só liga DOM e fetch; a lógica fica em ui-core.js.
// Regra de segurança (G2): todo texto entra por textContent; nada de innerHTML.
import * as core from './ui-core.js';

const API = '/apirest.php';
const STORAGE_KEY = 'system-a-ui-session';
const POLL_MS = 5_000;
const SVG_NS = 'http://www.w3.org/2000/svg';

const state = {
  config: null,
  session: null,
  timer: null,
  catalog: null,
  showTrash: false,
  tickets: [],
  detailId: null, // número, 'new' ou null
  ticket: null,
};

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'className') {
      node.className = value;
    } else if (key === 'text') {
      node.textContent = value;
    } else if (key.startsWith('on')) {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) {
      node.append(child);
    }
  }
  return node;
}

// Ícones desenhados (traço único, 24×24): nada de emoji como ícone
const ICONS = {
  building: ['M4 21V6l8-3v18', 'M12 9h8v12', 'M3 21h18', 'M8 8v.01', 'M8 12v.01', 'M8 16v.01', 'M16 13v.01', 'M16 17v.01'],
  sync: ['M20 11a8 8 0 0 0-14.9-3', 'M4 4v4h4', 'M4 13a8 8 0 0 0 14.9 3', 'M20 20v-4h-4'],
};

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function showBanner(node, text) {
  node.textContent = text || '';
  node.hidden = !text;
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function describe(err, action) {
  return core.errorMessage({
    status: err.status,
    code: err.code,
    message: err.message,
    profile: state.session?.profile,
    action,
  });
}

// ---------- sessão ----------

function loadSession() {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    return null;
  }
}

function saveSession(session) {
  state.session = session;
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

function clearSession() {
  state.session = null;
  state.catalog = null;
  state.showTrash = false;
  state.tickets = [];
  state.detailId = null;
  state.ticket = null;
  renderedActionsKey = null;
  sessionStorage.removeItem(STORAGE_KEY);
  // Nada da sessão anterior (formulário aberto, aviso de erro) aparece para o próximo usuário
  for (const form of document.querySelectorAll('main form:not(#login-form)')) {
    form.reset();
  }
  $('ticket-search').value = '';
  for (const banner of document.querySelectorAll('main .banner:not(#login-error)')) {
    showBanner(banner, '');
  }
}

function basicAuth(login, password) {
  const bytes = new TextEncoder().encode(`${login}:${password}`);
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return `Basic ${btoa(binary)}`;
}

// ---------- API ----------

async function loadConfig() {
  const res = await fetch('/ui/config.json', { cache: 'no-store' });
  if (!res.ok) {
    throw new ApiError(res.status, null, 'Não foi possível ler a configuração da UI.');
  }
  return res.json();
}

async function api(method, path, body, { headers = {} } = {}) {
  const allHeaders = { 'App-Token': state.config.appToken, ...headers };
  if (state.session) {
    allHeaders['Session-Token'] = state.session.token;
  }
  if (body !== undefined) {
    allHeaders['Content-Type'] = 'application/json';
  }

  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: allHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Sistema A fora do ar.');
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const [code, message] = Array.isArray(data) ? data : [null, `HTTP ${res.status}`];
    const err = new ApiError(res.status, code, message);
    if (state.session && core.isSessionError(code)) {
      expireSession(err);
    }
    throw err;
  }
  showBanner($('global-error'), '');
  return data;
}

function expireSession(err) {
  clearSession();
  renderWho();
  location.hash = '#/login';
  showBanner($('login-error'), describe(err));
}

// ---------- login ----------

async function onLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type=submit]');
  showBanner($('login-error'), '');
  button.disabled = true;
  try {
    const { session_token: token } = await api('GET', '/initSession', undefined, {
      headers: { Authorization: basicAuth(form.login.value, form.password.value) },
    });
    saveSession({ token });
    const { session } = await api('GET', '/getFullSession');
    saveSession({
      token,
      userId: session.glpiID,
      login: session.glpiname,
      profile: session.glpiactiveprofile.name,
    });
    form.password.value = '';
    renderWho();
    location.hash = '#/tickets';
  } catch (err) {
    clearSession();
    showBanner($('login-error'), describe(err));
  } finally {
    button.disabled = false;
  }
}

async function onLogout() {
  try {
    await api('GET', '/killSession');
  } catch {
    // A sessão some do navegador mesmo se o A estiver fora do ar.
  }
  clearSession();
  renderWho();
  location.hash = '#/login';
}

function renderWho() {
  const session = state.session;
  $('who').hidden = !session?.profile;
  const me = state.catalog?.users.find((u) => u.id === session?.userId);
  const name = core.userName(me) ?? session?.login ?? '';
  $('who-avatar').textContent = core.initials(name);
  $('who-label').textContent = session?.profile ? `${name} · ${core.profileLabel(session.profile)}` : '';
}

// ---------- catálogos e formulários ----------

function badge(status) {
  return el('span', { className: `badge status-${status}`, text: core.statusLabel(status) });
}

function fillOptions(select, values, labelOf, selected) {
  select.replaceChildren(
    ...values.map((value) => {
      const option = el('option', { value: String(value), text: labelOf(value) });
      option.selected = value === selected;
      return option;
    }),
  );
}

// Catálogos do GLPI (categorias, locais e usuários): carregados uma vez por sessão.
async function ensureCatalog() {
  if (state.catalog) {
    return state.catalog;
  }
  const [categories, locations, users] = await Promise.all([
    api('GET', '/ITILCategory'),
    api('GET', '/Location'),
    api('GET', '/User'),
  ]);
  state.catalog = { categories, locations, users };
  renderWho();
  return state.catalog;
}

// Select com a opção "—" (sem valor) seguida dos itens do catálogo.
function fillRefOptions(select, items, labelOf, selected) {
  const none = el('option', { value: '', text: '—' });
  none.selected = selected == null;
  select.replaceChildren(
    none,
    ...items.map((item) => {
      const option = el('option', { value: String(item.id), text: labelOf(item) });
      option.selected = item.id === selected;
      return option;
    }),
  );
}

function fillTicketRefs(prefix, ticket = {}) {
  const { categories, locations, users } = state.catalog;
  fillRefOptions($(`${prefix}-category`), categories, (c) => c.completename, ticket.itilcategories_id ?? null);
  fillRefOptions($(`${prefix}-location`), locations, (l) => l.name, ticket.locations_id ?? null);
  const tecnicos = users.filter((u) => u.profile === 'tecnico');
  fillRefOptions($(`${prefix}-assign`), tecnicos, core.userLabel, ticket.users_id_assign ?? null);
  // Requerente: qualquer pessoa (o sync-bot é conta técnica). Chamado novo assume quem abre, como no GLPI
  const people = users.filter((u) => u.profile !== 'sync-bot');
  const recipient = Object.hasOwn(ticket, 'id') ? ticket.users_id_recipient ?? null : state.session.userId;
  fillRefOptions($(`${prefix}-recipient`), people, core.userLabel, recipient);
}

const refValue = (select) => (select.value === '' ? null : Number(select.value));
const REF_FIELDS = ['itilcategories_id', 'locations_id', 'users_id_recipient', 'users_id_assign'];

// ---------- lista ----------

async function loadTickets() {
  const trash = state.showTrash ? 1 : 0;
  state.tickets = (await api('GET', `/Ticket?range=0-199&sort=date_mod&order=DESC&is_deleted=${trash}`)) || [];
  renderList();
  $('tickets-updated').textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR')}`;
}

function renderList() {
  const trash = state.showTrash;
  $('tickets-heading').textContent = trash ? 'Lixeira' : 'Chamados';
  $('trash-toggle').textContent = trash ? 'Voltar aos chamados' : 'Ver lixeira';
  const query = $('ticket-search').value;
  const visible = state.tickets.filter((t) => core.matchesSearch(t, query));
  $('tickets-body').replaceChildren(
    ...visible.map((t) => {
      const link = el(
        'a',
        { href: `#/tickets/${t.id}`, className: 'ticket-item' },
        el('span', { className: 'ticket-line' }, el('span', { className: 'ticket-name', text: `#${t.id} · ${t.name}` }), badge(t.status)),
        el('span', { className: 'ticket-sub', text: `${core.priorityLabel(t.priority)} · ${core.shortDate(t.date_mod)}` }),
      );
      if (t.id === state.detailId) {
        link.setAttribute('aria-current', 'true');
      }
      return el('li', {}, link);
    }),
  );
  const empty = $('tickets-empty');
  empty.hidden = visible.length > 0;
  empty.textContent = query.trim()
    ? 'Nenhum chamado bate com a busca.'
    : trash
      ? 'A lixeira está vazia.'
      : 'Nenhum chamado ainda. Use "Novo chamado" para abrir o primeiro.';
}

// ---------- área de trabalho: lista + detalhe ----------

function showPane(which) {
  $('detail-placeholder').hidden = which !== 'empty';
  $('new-ticket-form').hidden = which !== 'new';
  $('detail').hidden = which !== 'detail';
  $('screen-tickets').classList.toggle('has-detail', which !== 'empty');
}

const workspace = {
  screen: 'screen-tickets',
  async enter({ id }) {
    $('new-ticket-toggle').hidden = !core.canCreate(state.session.profile);
    await ensureCatalog();
    if (id !== state.detailId) {
      resetDetail();
    }
    state.detailId = id;
    if (id === 'new') {
      showPane('new');
      openNewTicket();
    } else if (id) {
      showPane('detail');
    } else {
      showPane('empty');
    }
    await refresh();
  },
};

async function refresh() {
  await loadTickets();
  if (typeof state.detailId === 'number') {
    await refreshDetail();
  }
}

function resetDetail() {
  state.ticket = null;
  renderedActionsKey = null;
  $('edit-form').hidden = true;
  $('timeline').replaceChildren();
  $('solution-text').value = '';
  showBanner($('actions-error'), '');
  showBanner($('edit-error'), '');
  showBanner($('note-error'), '');
}

// ---------- novo chamado ----------

function openNewTicket() {
  const form = $('new-ticket-form');
  form.reset();
  showBanner($('new-ticket-error'), '');
  fillOptions($('new-ticket-priority'), [1, 2, 3, 4, 5, 6], core.priorityLabel, 3);
  fillTicketRefs('new-ticket');
  form.name.focus();
}

async function onCreateTicket(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const created = await api('POST', '/Ticket', {
      input: {
        name: form.name.value.trim(),
        content: form.content.value,
        priority: Number(form.priority.value),
        ...Object.fromEntries(REF_FIELDS.map((f) => [f, refValue(form[f])])),
      },
    });
    form.reset();
    state.showTrash = false;
    location.hash = `#/tickets/${created.id}`;
  } catch (err) {
    showBanner($('new-ticket-error'), describe(err, 'abrir chamados'));
  } finally {
    button.disabled = false;
  }
}

// ---------- detalhe ----------

function fact(label, value) {
  return [el('dt', { text: label }), el('dd', { text: value })];
}

function renderTicket(ticket) {
  $('detail-title').textContent = `#${ticket.id} · ${ticket.name}`;
  $('detail-badges').replaceChildren(
    badge(ticket.status),
    ...(ticket.is_deleted === 1 ? [el('span', { className: 'badge trash', text: 'Na lixeira' })] : []),
  );
  const { categories, locations, users } = state.catalog ?? {};
  const user = (id) => core.userLabel((users || []).find((u) => u.id === id));
  $('detail-meta').textContent =
    `Prioridade ${core.priorityLabel(ticket.priority)} · aberto em ${core.shortDate(ticket.date)} · alterado em ${core.shortDate(ticket.date_mod)}`;
  const facts = [
    ...fact('Categoria', core.catalogLabel(categories, ticket.itilcategories_id)),
    ...fact('Local', core.catalogLabel(locations, ticket.locations_id, (l) => l.name)),
    ...fact('Requerente', user(ticket.users_id_recipient)),
    ...fact('Atribuído a', user(ticket.users_id_assign)),
  ];
  if (ticket.solvedate) {
    facts.push(...fact('Solucionado em', core.shortDate(ticket.solvedate)));
  }
  if (ticket.closedate) {
    facts.push(...fact('Fechado em', core.shortDate(ticket.closedate)));
  }
  $('detail-facts').replaceChildren(...facts);
  $('detail-content').textContent = core.htmlToText(ticket.content) || '(sem descrição)';
  $('edit-toggle').hidden = ticket.is_deleted === 1 || !core.canEdit(state.session.profile);
}

async function refreshDetail() {
  const id = state.detailId;
  const ticket = await api('GET', `/Ticket/${id}`);
  if (state.detailId !== id) {
    return;
  }
  state.ticket = ticket;
  renderTicket(ticket);
  renderActions(ticket);
  await renderHistory(ticket);
}

function toggleEdit(open) {
  const form = $('edit-form');
  form.hidden = !open;
  showBanner($('edit-error'), '');
  if (!open) {
    return;
  }
  const ticket = state.ticket;
  form.name.value = ticket.name;
  form.content.value = core.htmlToText(ticket.content);
  fillOptions($('edit-status'), core.editableStatuses(), core.statusLabel, ticket.status);
  fillOptions($('edit-priority'), [1, 2, 3, 4, 5, 6], core.priorityLabel, ticket.priority);
  fillTicketRefs('edit', ticket);
  form.name.focus();
}

async function onSaveTicket(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const ticket = state.ticket;
  const input = {};
  if (form.name.value.trim() !== ticket.name) {
    input.name = form.name.value.trim();
  }
  if (form.content.value !== core.htmlToText(ticket.content)) {
    input.content = form.content.value;
  }
  if (Number(form.status.value) !== ticket.status) {
    input.status = Number(form.status.value);
  }
  if (Number(form.priority.value) !== ticket.priority) {
    input.priority = Number(form.priority.value);
  }
  for (const field of REF_FIELDS) {
    if (refValue(form[field]) !== (ticket[field] ?? null)) {
      input[field] = refValue(form[field]);
    }
  }
  if (Object.keys(input).length === 0) {
    toggleEdit(false);
    return;
  }

  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  showBanner($('edit-error'), '');
  try {
    await api('PUT', `/Ticket/${ticket.id}`, { input });
    toggleEdit(false);
    renderedActionsKey = null;
    await refresh();
  } catch (err) {
    // 403/409: o aviso fica acima do formulário, que continua aberto com o que foi digitado.
    showBanner($('edit-error'), describe(err, 'editar chamados'));
  } finally {
    button.disabled = false;
  }
}

// ---------- ações do chamado (tela de trabalho do GLPI) ----------
// Cada botão é um PUT (ou DELETE) da API que o A já tem; o sync leva o resultado ao B.

let renderedActionsKey = null;

function renderActions(ticket) {
  const card = $('ticket-actions');
  card.hidden = !core.canAct(state.session?.profile);
  if (card.hidden) {
    return;
  }
  // O polling de 5 s não recria os botões à toa (o foco e o texto da solução ficam)
  const key = `${ticket.id}:${ticket.status}:${ticket.users_id_assign}:${ticket.is_deleted}`;
  if (key === renderedActionsKey) {
    return;
  }
  renderedActionsKey = key;
  // Só o que vale agora aparece; o próximo passo natural vem preenchido
  const actions = core.ticketActions(ticket, state.session.userId).filter((a) => a.enabled);
  $('solution-field').hidden = !actions.some((a) => a.id === 'solve');
  $('action-buttons').replaceChildren(
    ...actions.map((action) => {
      const classes = [action.primary ? '' : 'ghost', action.danger ? 'danger-outline' : ''].filter(Boolean);
      const button = el('button', { type: 'button', text: action.label, 'data-action': action.id });
      if (classes.length) {
        button.className = classes.join(' ');
      }
      button.addEventListener('click', () => runAction(action, button));
      return button;
    }),
  );
}

async function runAction(action, button) {
  const ticket = state.ticket;
  const error = $('actions-error');
  showBanner(error, '');
  const solution = $('solution-text').value.trim();
  if (action.id === 'solve' && !solution) {
    showBanner(error, 'Escreva a solução antes de solucionar.');
    $('solution-text').focus();
    return;
  }
  if (action.id === 'delete' && !confirm(`Mandar o chamado #${ticket.id} para a lixeira? O registro sai do Sistema B; restaurar o recria.`)) {
    return;
  }
  button.disabled = true;
  try {
    if (action.id === 'delete') {
      await api('DELETE', `/Ticket/${ticket.id}`);
    } else {
      if (action.id === 'solve') {
        // A solução fica no histórico do chamado, como o acompanhamento do GLPI
        await api('POST', '/ITILFollowup', {
          input: { itemtype: 'Ticket', items_id: ticket.id, content: core.solutionNote(solution) },
        });
      }
      await api('PUT', `/Ticket/${ticket.id}`, { input: action.input });
    }
    if (action.id === 'solve') {
      $('solution-text').value = '';
    }
    if (action.id === 'delete' || action.id === 'restore') {
      state.showTrash = action.id === 'delete';
    }
    renderedActionsKey = null;
    toggleEdit(false);
    await refresh();
  } catch (err) {
    showBanner(error, describe(err, 'mudar o chamado'));
    button.disabled = false;
  }
}

// ---------- histórico de atividade ----------

function avatar(author) {
  if (author.kind === 'operador') {
    return el('span', { className: 'avatar from-b', 'aria-hidden': 'true' }, icon('building'));
  }
  if (author.kind === 'sync') {
    return el('span', { className: 'avatar bot', 'aria-hidden': 'true' }, icon('sync'));
  }
  return el('span', { className: `avatar ${author.kind}`, 'aria-hidden': 'true', text: core.initials(author.name) });
}

function historyItem(item) {
  const events = item.events.map((event) =>
    el(
      'div',
      { className: `event ${event.type}` },
      event.tag ? el('span', { className: `tag ${event.type}`, text: event.tag }) : null,
      el('p', { className: 'event-text', text: event.text }),
      event.quote ? el('blockquote', { text: `Solução: ${event.quote}` }) : null,
    ),
  );
  return el(
    'li',
    { className: `entry ${item.author.kind}` },
    avatar(item.author),
    el(
      'div',
      { className: 'entry-body' },
      el(
        'div',
        { className: 'entry-head' },
        el('strong', { text: item.author.name }),
        el('span', { className: 'role', text: item.author.role }),
        item.private ? el('span', { className: 'role', text: 'privada' }) : null,
        el('time', { text: item.when }),
      ),
      ...events,
    ),
  );
}

async function renderHistory(ticket) {
  if (!state.config.features.followups) {
    $('conversation').hidden = true;
    return;
  }
  const followups = await api('GET', `/Ticket/${ticket.id}/ITILFollowup`);
  if (state.detailId !== ticket.id) {
    return;
  }
  $('conversation').hidden = false;
  $('note-form').hidden = !core.canAddNote(state.session.profile);
  const items = core.buildTimeline(followups || [], state.catalog?.users);
  $('timeline').replaceChildren(
    ...(items.length
      ? items.map(historyItem)
      : [el('li', { className: 'hint', text: 'Nada registrado ainda. Notas, a solução e o que o Sistema B mudar aparecem aqui.' })]),
  );
}

async function onAddNote(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const content = form.content.value.trim();
  if (!content) {
    return;
  }
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  showBanner($('note-error'), '');
  try {
    await api('POST', '/ITILFollowup', {
      input: { itemtype: 'Ticket', items_id: state.detailId, content },
    });
    form.reset();
    await refreshDetail();
  } catch (err) {
    showBanner($('note-error'), describe(err, 'adicionar notas'));
  } finally {
    button.disabled = false;
  }
}

// ---------- roteamento por hash ----------

let currentView = null;

function stopPolling() {
  clearInterval(state.timer);
  state.timer = null;
}

function startPolling() {
  stopPolling();
  state.timer = setInterval(() => {
    if (document.hidden || !currentView) {
      return;
    }
    refresh().catch((err) => showBanner($('global-error'), describe(err)));
  }, POLL_MS);
}

function showScreen(id) {
  for (const screen of document.querySelectorAll('.screen')) {
    screen.hidden = screen.id !== id;
  }
}

function resolveRoute() {
  const hash = location.hash || '#/tickets';
  if (hash === '#/login') {
    return null;
  }
  if (hash === '#/tickets/new') {
    return { id: 'new' };
  }
  const detail = /^#\/tickets\/(\d+)$/.exec(hash);
  return { id: detail ? Number(detail[1]) : null };
}

async function route() {
  stopPolling();
  showBanner($('global-error'), '');
  if (!state.session?.profile) {
    currentView = null;
    showScreen('screen-login');
    if (location.hash !== '#/login') {
      location.hash = '#/login';
    }
    return;
  }
  const params = resolveRoute();
  if (!params) {
    location.hash = '#/tickets';
    return;
  }
  currentView = workspace;
  showScreen(workspace.screen);
  try {
    await workspace.enter(params);
  } catch (err) {
    showBanner($('global-error'), describe(err));
  }
  startPolling();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentView) {
    refresh().catch((err) => showBanner($('global-error'), describe(err)));
  }
});

async function start() {
  $('login-form').addEventListener('submit', onLogin);
  $('logout').addEventListener('click', onLogout);
  $('new-ticket-toggle').addEventListener('click', () => (location.hash = '#/tickets/new'));
  $('new-ticket-cancel').addEventListener('click', () => (location.hash = '#/tickets'));
  $('new-ticket-form').addEventListener('submit', onCreateTicket);
  $('trash-toggle').addEventListener('click', () => {
    state.showTrash = !state.showTrash;
    loadTickets().catch((err) => showBanner($('global-error'), describe(err)));
  });
  $('ticket-search').addEventListener('input', renderList);
  $('edit-toggle').addEventListener('click', () => toggleEdit($('edit-form').hidden));
  $('edit-cancel').addEventListener('click', () => toggleEdit(false));
  $('edit-form').addEventListener('submit', onSaveTicket);
  $('note-form').addEventListener('submit', onAddNote);
  window.addEventListener('hashchange', route);

  try {
    state.config = await loadConfig();
  } catch (err) {
    showScreen('screen-login');
    showBanner($('login-error'), describe(err.status ? err : new ApiError(0, 'NETWORK', '')));
    return;
  }
  state.session = loadSession();
  renderWho();
  await route();
}

start();
