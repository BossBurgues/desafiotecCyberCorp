// UI do Operador B. Sem dependências e sem montar HTML a partir de texto: tudo que vem do B entra via textContent.
// Usa as rotas /operator/records, que ficam fora do caos e do contrato do sync. O B não filtra nem busca (de
// propósito, ADR-003): a UI carrega a listagem e filtra no navegador.

const PAGE_SIZE = 20;
const LIST_POLL_MS = 10_000;
const STATES = { OPEN: 'Aberto', IN_PROGRESS: 'Em andamento', ON_HOLD: 'Em espera', RESOLVED: 'Resolvido', CLOSED: 'Fechado' };
const SEVERITIES = { LOW: 'Baixa', MEDIUM: 'Média', HIGH: 'Alta', CRITICAL: 'Crítica' };
const MARKER = /⟦s:glpi-(\d+)⟧/;
const SESSION_KEY = 'systemb.session';
const INTRO_KEY = 'systemb.intro-dismissed';
const SYNC_AUTHOR = 'integração (sync)';

// Ações rápidas: o estado em que o registro já está não é oferecido; o próximo passo natural vem preenchido
const STATE_ACTIONS = [
  { state: 'IN_PROGRESS', label: 'Em andamento' },
  { state: 'ON_HOLD', label: 'Em espera' },
  { state: 'RESOLVED', label: 'Resolver' },
  { state: 'CLOSED', label: 'Fechar' },
  { state: 'OPEN', label: 'Reabrir', only: ['RESOLVED', 'CLOSED'] },
];
const NEXT_STEP = { OPEN: 'IN_PROGRESS', IN_PROGRESS: 'RESOLVED', ON_HOLD: 'IN_PROGRESS', RESOLVED: 'CLOSED', CLOSED: 'OPEN' };

const $ = (id) => document.getElementById(id);
const view = {
  all: [],
  filters: { q: '', state: '', severity: '', ticket: '' },
  page: 1,
  current: null,
  timer: null,
};

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') node.textContent = v;
    else if (k === 'className') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

function banner(id, message) {
  const node = $(id);
  node.textContent = message || '';
  node.hidden = !message;
}

function show(message, kind = 'error') {
  banner('global-error', kind === 'error' ? message : '');
  banner('global-ok', kind === 'ok' ? message : '');
}

function stored(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // sem armazenamento: só não lembra entre visitas
  }
}

// Sessão do operador: o token vai em X-Session-Token; o nome da conta é quem o B grava como "quem alterou"
// (updatedBy), e o sync leva esse nome para o histórico no A. Fica na aba (sessionStorage), como no A.
let session = null;

function loadSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    return null;
  }
}

function saveSession(value) {
  session = value;
  try {
    if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // sem armazenamento: a sessão vale até recarregar a página
  }
}

class SessionExpired extends Error {}

async function api(path, options = {}) {
  const headers = options.body ? { 'Content-Type': 'application/json' } : {};
  if (session?.token) headers['X-Session-Token'] = session.token;
  const res = await fetch(path, { ...options, headers });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => null);
  if (res.status === 401 && path.startsWith('/operator/records')) {
    saveSession(null);
    location.hash = '#/login';
    throw new SessionExpired('Sua sessão expirou. Entre de novo.');
  }
  if (!res.ok) {
    if (res.status === 410) throw new Error(`Registro excluído por ${body.deletedBy} em ${when(body.deletedAt)}.`);
    const detail = body && body.message ? body.message : `HTTP ${res.status}`;
    throw new Error(`${res.status === 404 ? 'Não encontrado' : 'Erro'}: ${detail}`);
  }
  return body;
}

const when = (iso) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

function aTicket(record) {
  const m = MARKER.exec(record.description || '');
  return m ? Number(m[1]) : null;
}

function badge(state) {
  return el('span', { className: `badge ${state}`, text: STATES[state] || state });
}

function fillSelect(select, labels, emptyLabel) {
  const options = Object.entries(labels).map(([value, label]) => el('option', { value, text: label }));
  if (emptyLabel) options.unshift(el('option', { value: '', text: emptyLabel }));
  select.replaceChildren(...options);
}

// ---------- lista, filtros e paginação ----------

async function loadAll() {
  const all = [];
  for (let page = 1; ; page++) {
    const data = await api(`/operator/records?page=${page}&pageSize=200`);
    all.push(...data.items);
    if (data.items.length === 0 || page * data.pageSize >= data.total) break;
  }
  // Os mais recentes primeiro: o que o sync acabou de entregar aparece no topo
  view.all = all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

function fold(text) {
  return String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function filtered() {
  const { q, state, severity, ticket } = view.filters;
  const query = fold(q.trim()).replace(/^#/, '');
  const ticketId = ticket.trim().replace(/^#/, '');
  return view.all.filter((r) => {
    if (state && r.state !== state) return false;
    if (severity && r.severity !== severity) return false;
    if (ticketId && String(aTicket(r)) !== ticketId) return false;
    if (!query) return true;
    return fold(r.id).includes(query) || fold(r.title).includes(query) || String(aTicket(r)) === query;
  });
}

const FILTER_LABELS = {
  q: (v) => `Busca: ${v}`,
  state: (v) => `Estado: ${STATES[v]}`,
  severity: (v) => `Severidade: ${SEVERITIES[v]}`,
  ticket: (v) => `Chamado do A: #${v.replace(/^#/, '')}`,
};

function renderChips() {
  const chips = Object.entries(view.filters)
    .filter(([, value]) => value.trim())
    .map(([key, value]) => {
      const remove = el('button', { type: 'button', className: 'chip-remove', 'aria-label': `Remover filtro ${FILTER_LABELS[key](value)}`, text: '×' });
      remove.addEventListener('click', () => {
        view.filters[key] = '';
        $('filters').elements[key].value = '';
        view.page = 1;
        renderList();
      });
      return el('li', { className: 'chip' }, [el('span', { text: FILTER_LABELS[key](value) }), remove]);
    });
  $('filter-chips').replaceChildren(...chips);
}

function renderList() {
  const rows = filtered();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  view.page = Math.min(Math.max(1, view.page), pages);
  const slice = rows.slice((view.page - 1) * PAGE_SIZE, view.page * PAGE_SIZE);
  const selected = view.current?.id;

  $('records-body').replaceChildren(
    ...slice.map((r) => {
      const ticket = aTicket(r);
      const row = el('tr', { tabindex: '0' }, [
        el('td', { className: 'mono', text: r.id }),
        el('td', { text: ticket ? `#${ticket}` : '—' }),
        el('td', { className: 'title', text: r.title }),
        el('td', {}, [badge(r.state)]),
        el('td', { text: SEVERITIES[r.severity] || r.severity }),
        el('td', { className: 'muted when' }, [
          el('span', { text: when(r.updatedAt) }),
          // Só quando foi uma pessoa: "por integração (sync)" em toda linha é ruído
          r.updatedBy && r.updatedBy !== SYNC_AUTHOR ? el('span', { className: 'by', text: `por ${r.updatedBy}` }) : null,
        ]),
      ]);
      if (r.id === selected) row.setAttribute('aria-selected', 'true');
      const open = () => (location.hash = `#/records/${encodeURIComponent(r.id)}`);
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => e.key === 'Enter' && open());
      return row;
    }),
  );

  const any = Object.values(view.filters).some((v) => v.trim());
  $('summary-count').textContent = any
    ? `Mostrando ${rows.length} de ${view.all.length} registro(s)`
    : `${view.all.length} registro(s)`;
  const empty = $('records-empty');
  empty.hidden = rows.length > 0;
  empty.textContent = any ? 'Nenhum registro bate com os filtros. Use "Limpar filtros" para ver todos.' : 'Nenhum registro no B ainda. Os chamados do A aparecem aqui assim que o sync os entrega.';
  $('page-label').textContent = `Página ${view.page} de ${pages}`;
  $('prev-page').disabled = view.page <= 1;
  $('next-page').disabled = view.page >= pages;
  renderChips();
}

async function refreshList() {
  await loadAll();
  renderList();
}

// ---------- painel do registro ----------

function fillForm(r) {
  const f = $('edit-form').elements;
  for (const name of ['title', 'description', 'state', 'severity', 'category', 'requester', 'assignee', 'resolution']) {
    f[name].value = r[name] ?? '';
  }
}

function renderStateButtons(r) {
  const next = NEXT_STEP[r.state];
  $('state-buttons').replaceChildren(
    ...STATE_ACTIONS.filter((a) => a.state !== r.state && (!a.only || a.only.includes(r.state))).map((a) => {
      const button = el('button', { type: 'button', className: a.state === next ? '' : 'ghost', text: a.label });
      button.addEventListener('click', () => {
        const changes = { state: a.state };
        if (['RESOLVED', 'CLOSED'].includes(a.state)) changes.resolution = $('quick-resolution').value;
        save(changes, `Estado alterado para ${STATES[a.state]}.`);
      });
      return button;
    }),
    (() => {
      const del = el('button', { type: 'button', className: 'danger-outline', text: 'Excluir' });
      del.addEventListener('click', onDelete);
      return del;
    })(),
  );
}

async function openDetail(id) {
  banner('detail-error', '');
  $('detail').hidden = false;
  try {
    view.current = await api(`/operator/records/${encodeURIComponent(id)}`);
  } catch (e) {
    view.current = null;
    $('detail-title').textContent = id;
    $('detail-meta').textContent = '';
    $('detail-state').hidden = true;
    $('quick-actions').hidden = $('edit-form').hidden = true;
    banner('detail-error', e.message);
    return;
  }
  const r = view.current;
  const ticket = aTicket(r);
  $('detail-title').textContent = `${r.id} · ${r.title}`;
  $('detail-state').replaceWith(Object.assign(badge(r.state), { id: 'detail-state' }));
  $('detail-meta').textContent =
    `Chamado do A ${ticket ? `#${ticket}` : '—'} · criado ${when(r.createdAt)} · atualizado ${when(r.updatedAt)}` +
    (r.updatedBy ? ` por ${r.updatedBy}` : '');
  $('quick-actions').hidden = $('edit-form').hidden = false;
  $('quick-resolution').value = r.resolution ?? '';
  renderStateButtons(r);
  fillForm(r);
  renderList();
}

function closeDetail() {
  view.current = null;
  $('detail').hidden = true;
  renderList();
}

// PUT é substituição completa: parte do registro atual para não apagar localização, anexos e sourceUpdatedAt
function bodyFrom(record, changes) {
  const { id, createdAt, updatedAt, updatedBy, ...input } = record;
  const blankToNull = (v) => (v === '' ? null : v);
  return JSON.stringify({
    ...input,
    ...changes,
    category: blankToNull(changes.category ?? input.category),
    requester: blankToNull(changes.requester ?? input.requester),
    assignee: blankToNull(changes.assignee ?? input.assignee),
    resolution: blankToNull(changes.resolution ?? input.resolution ?? null),
  });
}

async function save(changes, message) {
  const current = view.current;
  try {
    const updated = await api(`/operator/records/${encodeURIComponent(current.id)}`, {
      method: 'PUT',
      body: bodyFrom(current, changes),
    });
    show(message, 'ok');
    await refreshList();
    await openDetail(updated.id);
  } catch (e) {
    banner('detail-error', e.message);
  }
}

async function onDelete() {
  const current = view.current;
  if (!confirm(`Excluir ${current.id} do B? O chamado vai para a lixeira do A (reversível).`)) return;
  try {
    await api(`/operator/records/${encodeURIComponent(current.id)}`, { method: 'DELETE' });
    show(`${current.id} excluído. O chamado do A vai para a lixeira na próxima varredura do sync.`, 'ok');
    location.hash = '#/records';
    await refreshList();
  } catch (e) {
    banner('detail-error', e.message);
  }
}

// ---------- acesso: entrar, criar conta, sair ----------

function initials(name) {
  return (
    String(name ?? '')
      .replace(/\(.*?\)/g, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join('') || '?'
  );
}

function renderWho() {
  $('who').hidden = !session;
  $('who-name').textContent = session?.name ?? '';
  $('who-avatar').textContent = initials(session?.name);
}

async function signIn(login, password) {
  const res = await api('/operator/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login: login.trim().toLowerCase(), password }),
  });
  saveSession({ token: res.token, login: res.login, name: res.name });
  renderWho();
  view.all = [];
  location.hash = '#/records';
}

async function onLogin(e) {
  e.preventDefault();
  const form = e.currentTarget;
  banner('login-error', '');
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    await signIn(form.login.value, form.password.value);
    form.password.value = '';
  } catch (err) {
    banner('login-error', err.message.replace(/^Erro: /, ''));
  } finally {
    button.disabled = false;
  }
}

async function onRegister(e) {
  e.preventDefault();
  const form = e.currentTarget;
  banner('register-error', '');
  if (form.password.value !== form.confirm.value) {
    banner('register-error', 'As duas senhas não são iguais.');
    form.confirm.focus();
    return;
  }
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    await api('/operator/auth/register', {
      method: 'POST',
      body: JSON.stringify({ login: form.login.value.trim().toLowerCase(), name: form.name.value.trim(), password: form.password.value }),
    });
    await signIn(form.login.value, form.password.value);
    form.reset();
  } catch (err) {
    banner('register-error', err.message.replace(/^Erro: /, ''));
  } finally {
    button.disabled = false;
  }
}

async function onLogout() {
  try {
    await api('/operator/auth/logout', { method: 'POST' });
  } catch {
    // a sessão some da aba mesmo com o B fora do ar
  }
  saveSession(null);
  renderWho();
  view.all = [];
  view.current = null;
  $('detail').hidden = true;
  location.hash = '#/login';
}

function showAuth(mode) {
  const register = mode === 'register';
  $('screen-auth').hidden = false;
  $('screen-app').hidden = true;
  $('login-form').hidden = register;
  $('register-form').hidden = !register;
  $('tab-login').setAttribute('aria-selected', String(!register));
  $('tab-register').setAttribute('aria-selected', String(register));
}

// ---------- rota ----------

async function route() {
  if (!session) {
    if (location.hash !== '#/login' && location.hash !== '#/register') {
      location.hash = '#/login';
      return;
    }
    showAuth(location.hash === '#/register' ? 'register' : 'login');
    return;
  }
  if (location.hash === '#/login' || location.hash === '#/register') {
    location.hash = '#/records';
    return;
  }
  $('screen-auth').hidden = true;
  $('screen-app').hidden = false;
  const m = /^#\/records\/(.+)$/.exec(location.hash);
  try {
    if (!view.all.length) await refreshList();
    if (m) {
      await openDetail(decodeURIComponent(m[1]));
      $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      closeDetail();
    }
  } catch (e) {
    if (!(e instanceof SessionExpired)) show(e.message);
  }
}

function wire() {
  session = loadSession();
  renderWho();
  $('login-form').addEventListener('submit', onLogin);
  $('register-form').addEventListener('submit', onRegister);
  $('logout').addEventListener('click', onLogout);

  if (stored(INTRO_KEY)) $('intro').hidden = true;
  $('intro-close').addEventListener('click', () => {
    $('intro').hidden = true;
    store(INTRO_KEY, '1');
  });


  const filters = $('filters');
  fillSelect(filters.elements.state, STATES, 'Todos');
  fillSelect(filters.elements.severity, SEVERITIES, 'Todas');
  fillSelect($('edit-form').elements.state, STATES);
  fillSelect($('edit-form').elements.severity, SEVERITIES);

  filters.addEventListener('submit', (e) => {
    e.preventDefault();
    for (const key of Object.keys(view.filters)) view.filters[key] = filters.elements[key].value;
    view.page = 1;
    renderList();
  });
  $('clear-filters').addEventListener('click', () => {
    filters.reset();
    for (const key of Object.keys(view.filters)) view.filters[key] = '';
    view.page = 1;
    renderList();
  });

  $('refresh').addEventListener('click', () => {
    show('');
    refreshList().catch((e) => show(e.message));
  });
  $('prev-page').addEventListener('click', () => {
    view.page -= 1;
    renderList();
  });
  $('next-page').addEventListener('click', () => {
    view.page += 1;
    renderList();
  });
  $('detail-close').addEventListener('click', () => (location.hash = '#/records'));

  $('edit-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.elements;
    save(
      {
        title: f.title.value,
        description: f.description.value,
        state: f.state.value,
        severity: f.severity.value,
        category: f.category.value,
        requester: f.requester.value,
        assignee: f.assignee.value,
        resolution: f.resolution.value,
      },
      'Campos salvos.',
    );
  });

  // A lista acompanha o sync sozinha; o painel aberto não é recarregado (o que está sendo digitado fica)
  view.timer = setInterval(() => {
    if (!document.hidden && session && !$('screen-app').hidden) refreshList().catch(() => undefined);
  }, LIST_POLL_MS);

  window.addEventListener('hashchange', route);
  if (!location.hash) location.hash = session ? '#/records' : '#/login';
  else route();
}

wire();
