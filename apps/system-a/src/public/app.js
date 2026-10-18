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
