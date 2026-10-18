// UI do Sistema A (S1.6): só liga DOM e fetch; a lógica fica em ui-core.js.
// Regra de segurança (G2): todo texto entra por textContent; nada de innerHTML.
import * as core from './ui-core.js';

const API = '/apirest.php';
const STORAGE_KEY = 'system-a-ui-session';
const LIST_POLL_MS = 10_000;
const DETAIL_POLL_MS = 5_000;

const state = {
  config: null,
  session: null,
  timer: null,
  detailId: null,
  ticket: null,
};

// Telas extras registradas pelas seções seguintes (detalhe, conversa, aprovações).
const views = {};
const detailExtensions = [];

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
    if (child !== null && child !== undefined) {
      node.append(child);
    }
  }
  return node;
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
  sessionStorage.removeItem(STORAGE_KEY);
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
  $('who-label').textContent = session?.profile
    ? `👤 ${core.profileLabel(session.profile)} (${session.login})`
    : '';
}

// ---------- lista e criação ----------

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

async function refreshTickets() {
  const tickets = await api('GET', '/Ticket?range=0-49&sort=date_mod&order=DESC');
  const rows = (tickets || []).map((t) =>
    el(
      'tr',
      { onClick: () => (location.hash = `#/tickets/${t.id}`) },
      el('td', { text: String(t.id) }),
      el('td', {}, el('a', { href: `#/tickets/${t.id}`, text: t.name })),
      el('td', {}, badge(t.status)),
      el('td', { text: core.priorityLabel(t.priority) }),
      el('td', { text: t.date_mod }),
    ),
  );
  $('tickets-body').replaceChildren(...rows);
  $('tickets-empty').hidden = rows.length > 0;
  $('tickets-updated').textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR')} (a cada 10 s).`;
}

views.tickets = {
  screen: 'screen-tickets',
  pollMs: LIST_POLL_MS,
  async enter() {
    $('new-ticket-toggle').hidden = !core.canCreate(state.session.profile);
    await refreshTickets();
  },
  refresh: refreshTickets,
};

function toggleNewTicket(open) {
  const form = $('new-ticket-form');
  form.hidden = !open;
  showBanner($('new-ticket-error'), '');
  if (open) {
    fillOptions($('new-ticket-priority'), [1, 2, 3, 4, 5, 6], core.priorityLabel, 3);
    form.name.focus();
  } else {
    form.reset();
  }
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
      },
    });
    toggleNewTicket(false);
    location.hash = `#/tickets/${created.id}`;
  } catch (err) {
    showBanner($('new-ticket-error'), describe(err, 'abrir chamados'));
  } finally {
    button.disabled = false;
  }
}

// ---------- roteamento por hash ----------

function stopPolling() {
  clearInterval(state.timer);
  state.timer = null;
}

function startPolling(view) {
  stopPolling();
  if (!view.pollMs || !view.refresh) {
    return;
  }
  state.timer = setInterval(() => {
    if (document.hidden) {
      return;
    }
    view.refresh().catch((err) => showBanner($('global-error'), describe(err)));
  }, view.pollMs);
}

function showScreen(id) {
  for (const screen of document.querySelectorAll('.screen')) {
    screen.hidden = screen.id !== id;
  }
}

function resolveRoute() {
  const hash = location.hash || '#/tickets';
  const detail = /^#\/tickets\/(\d+)$/.exec(hash);
  if (detail && views.detail) {
    return { view: views.detail, params: { id: Number(detail[1]) } };
  }
  if (hash === '#/login') {
    return { view: null, params: {} };
  }
  return { view: views.tickets, params: {} };
}

let currentView = null;

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
  const { view, params } = resolveRoute();
  if (!view) {
    location.hash = '#/tickets';
    return;
  }
  currentView = view;
  showScreen(view.screen);
  try {
    await view.enter(params);
  } catch (err) {
    showBanner($('global-error'), describe(err));
  }
  if (currentView === view) {
    startPolling(view);
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentView?.refresh) {
    currentView.refresh().catch((err) => showBanner($('global-error'), describe(err)));
  }
});

async function start() {
  $('login-form').addEventListener('submit', onLogin);
  $('logout').addEventListener('click', onLogout);
  $('new-ticket-toggle').addEventListener('click', () => toggleNewTicket(true));
  $('new-ticket-cancel').addEventListener('click', () => toggleNewTicket(false));
  $('new-ticket-form').addEventListener('submit', onCreateTicket);
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

// Seções seguintes registram views.detail e detailExtensions antes do start.
queueMicrotask(start);

// ---------- detalhe e edição ----------

function renderTicket(ticket) {
  $('detail-title').textContent = `#${ticket.id} · ${ticket.name}`;
  $('detail-meta').replaceChildren(
    badge(ticket.status),
    ` · Prioridade ${core.priorityLabel(ticket.priority)} · aberto em ${ticket.date} · alterado em ${ticket.date_mod}`,
  );
  $('detail-content').textContent = core.htmlToText(ticket.content) || '(sem descrição)';
}

async function refreshDetail() {
  const id = state.detailId;
  const ticket = await api('GET', `/Ticket/${id}`);
  if (state.detailId !== id) {
    return;
  }
  state.ticket = ticket;
  renderTicket(ticket);
  for (const extension of detailExtensions) {
    await extension(ticket);
  }
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
  const statuses = core.editableStatuses();
  fillOptions($('edit-status'), statuses, core.statusLabel, ticket.status);
  if (!statuses.includes(ticket.status)) {
    // Solucionado/Fechado aparece só como valor atual, sem poder ser escolhido.
    const current = el('option', { value: String(ticket.status), text: core.statusLabel(ticket.status) });
    current.disabled = true;
    current.selected = true;
    $('edit-status').prepend(current);
  }
  fillOptions($('edit-priority'), [1, 2, 3, 4, 5, 6], core.priorityLabel, ticket.priority);
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
  if (Object.keys(input).length === 0) {
    toggleEdit(false);
    return;
  }

  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  showBanner($('edit-error'), '');
  try {
    state.ticket = await api('PUT', `/Ticket/${ticket.id}`, { input });
    renderTicket(state.ticket);
    toggleEdit(false);
  } catch (err) {
    // 403/409: o aviso fica acima do formulário, que continua aberto com o que foi digitado.
    showBanner($('edit-error'), describe(err, 'editar chamados'));
  } finally {
    button.disabled = false;
  }
}

views.detail = {
  screen: 'screen-detail',
  pollMs: DETAIL_POLL_MS,
  async enter({ id }) {
    if (state.detailId !== id) {
      toggleEdit(false);
    }
    state.detailId = id;
    $('edit-toggle').hidden = !core.canEdit(state.session.profile);
    await refreshDetail();
  },
  refresh: refreshDetail,
};

$('edit-toggle').addEventListener('click', () => toggleEdit($('edit-form').hidden));
$('edit-cancel').addEventListener('click', () => toggleEdit(false));
$('edit-form').addEventListener('submit', onSaveTicket);

// ---------- conversa (S1.4) e aprovações (S1.5) ----------
// Cada seção liga sozinha quando o servidor informa a rota em config.features.

let renderedPendingKey = null;

function bubble(item) {
  const classes = ['bubble'];
  if (item.kind !== 'note') {
    classes.push('event');
  } else if (item.author.icon === '🏢') {
    classes.push('from-b');
  } else if (item.author.icon === '🤖') {
    classes.push('bot');
  }
  let title = `${item.author.icon} ${item.author.label} · ${item.date}`;
  if (item.kind === 'solution') {
    title += ` · solução proposta (${core.solutionStatusLabel(item.status)})`;
  }
  if (item.private) {
    title += ' · privada';
  }
  return el(
    'li',
    { className: classes.join(' ') },
    el('div', { className: 'who-line', text: title }),
    el('div', { className: 'text', text: item.text }),
  );
}

function renderPending(solution, notice) {
  const box = $('detail-pending');
  const key = notice ? 'notice' : solution ? `${solution.id}` : 'none';
  if (key === renderedPendingKey) {
    return;
  }
  renderedPendingKey = key;
  if (notice) {
    box.replaceChildren(el('p', { className: 'notice', text: notice }));
    return;
  }
  if (!solution) {
    box.replaceChildren();
    return;
  }

  const author = core.authorOf(solution);
  const card = el(
    'section',
    { className: 'card pending' },
    el('h2', { text: '⏳ Solução aguardando aprovação' }),
    el('div', { className: 'meta', text: `${author.icon} ${author.label} · ${solution.date_creation}` }),
    el('p', { text: core.stripMarkers(solution.content) }),
  );

  if (!core.canDecide(state.session.profile)) {
    card.append(el('p', { className: 'hint', text: 'Aguardando aprovação de um Técnico.' }));
    box.replaceChildren(card);
    return;
  }

  const error = el('div', { className: 'banner error', role: 'alert' });
  error.hidden = true;
  const reason = el('textarea', { rows: '2', placeholder: 'Motivo (obrigatório para recusar)' });
  const decide = async (status, button) => {
    const input = { status };
    if (status === 4) {
      if (!reason.value.trim()) {
        showBanner(error, 'Informe o motivo para recusar a solução.');
        reason.focus();
        return;
      }
      input.content = reason.value.trim();
    }
    button.disabled = true;
    showBanner(error, '');
    try {
      await api('PUT', `/ITILSolution/${solution.id}`, { input });
      renderedPendingKey = null;
      await refreshDetail();
    } catch (err) {
      showBanner(error, describe(err, 'aprovar ou recusar soluções'));
    } finally {
      button.disabled = false;
    }
  };
  const approve = el('button', { type: 'button', text: 'Aprovar' });
  const refuse = el('button', { type: 'button', className: 'danger', text: 'Recusar' });
  approve.addEventListener('click', () => decide(3, approve));
  refuse.addEventListener('click', () => decide(4, refuse));
  card.append(error, el('label', { text: 'Motivo da recusa' }, reason), el('div', { className: 'actions' }, approve, refuse));
  box.replaceChildren(card);
}

async function renderConversation(ticket) {
  const { followups: hasFollowups, solutions: hasSolutions } = state.config.features;
  const [followups, solutions] = await Promise.all([
    hasFollowups ? api('GET', `/Ticket/${ticket.id}/ITILFollowup`) : [],
    hasSolutions ? api('GET', `/Ticket/${ticket.id}/ITILSolution`) : [],
  ]);
  if (state.detailId !== ticket.id) {
    return;
  }

  renderPending(
    core.pendingSolution(solutions || []),
    hasSolutions ? null : 'Aprovações disponíveis quando a S1.5 (#20) entrar.',
  );

  $('conversation-off').hidden = hasFollowups;
  $('note-form').hidden = !(hasFollowups && core.canAddNote(state.session.profile));
  const items = core.buildTimeline(followups || [], solutions || []);
  $('timeline').replaceChildren(...items.map(bubble));
  if (hasFollowups && items.length === 0) {
    $('timeline').append(el('li', { className: 'hint', text: 'Nenhuma nota ainda.' }));
  }
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

const enterDetail = views.detail.enter;
views.detail.enter = async (params) => {
  if (state.detailId !== params.id) {
    renderedPendingKey = null;
    $('timeline').replaceChildren();
    $('detail-pending').replaceChildren();
  }
  await enterDetail(params);
};

detailExtensions.push(renderConversation);
$('note-form').addEventListener('submit', onAddNote);
