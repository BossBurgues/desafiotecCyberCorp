// UI do Operador B (S2.4). Sem dependências e sem montar HTML a partir de texto: tudo que vem do B entra via textContent.
// Usa as rotas /operator/records, que ficam fora do caos e do contrato do sync.

const PAGE_SIZE = 20;
const STATES = { OPEN: 'Aberto', IN_PROGRESS: 'Em andamento', ON_HOLD: 'Em espera', RESOLVED: 'Resolvido', CLOSED: 'Fechado' };
const SEVERITIES = { LOW: 'Baixa', MEDIUM: 'Média', HIGH: 'Alta', CRITICAL: 'Crítica' };
const MARKER = /⟦s:glpi-(\d+)⟧/;

const $ = (id) => document.getElementById(id);
let page = 1;
let current = null;
let flash = null; // mensagem que sobrevive à troca de tela

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') node.textContent = v;
    else if (k === 'className') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function show(message, kind = 'error') {
  const error = $('global-error');
  const ok = $('global-ok');
  error.hidden = ok.hidden = true;
  if (!message) return;
  const target = kind === 'error' ? error : ok;
  target.textContent = message;
  target.hidden = false;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body && body.message ? body.message : `HTTP ${res.status}`;
    throw new Error(`${res.status === 404 ? 'Não encontrado' : 'Erro'}: ${detail}`);
  }
  return body;
}

function aTicket(record) {
  const m = MARKER.exec(record.description || '');
  return m ? `#${m[1]}` : '—';
}

function badge(state) {
  return el('span', { className: `badge ${state}`, text: STATES[state] || state });
}

function fillSelect(select, labels) {
  select.replaceChildren(...Object.entries(labels).map(([value, label]) => el('option', { value, text: label })));
}

function screen(name) {
  $('screen-list').hidden = name !== 'list';
  $('screen-detail').hidden = name !== 'detail';
}

async function renderList() {
  screen('list');
  const data = await api(`/operator/records?page=${page}&pageSize=${PAGE_SIZE}`);
  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  if (page > pages) {
    page = pages;
    return renderList();
  }
  $('records-body').replaceChildren(
    ...data.items.map((r) => {
      const row = el('tr', { tabindex: '0' }, [
        el('td', { text: r.id }),
        el('td', { text: aTicket(r) }),
        el('td', { className: 'title', text: r.title }),
        el('td', {}, [badge(r.state)]),
        el('td', { text: SEVERITIES[r.severity] || r.severity }),
        el('td', { className: 'muted', text: new Date(r.updatedAt).toLocaleString('pt-BR') }),
      ]);
      const open = () => (location.hash = `#/records/${encodeURIComponent(r.id)}`);
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => e.key === 'Enter' && open());
      return row;
    }),
  );
  $('records-empty').hidden = data.items.length > 0;
  $('page-label').textContent = `Página ${page} de ${pages} · ${data.total} registro(s)`;
  $('prev-page').disabled = page <= 1;
  $('next-page').disabled = page >= pages;
}

function fillForm(r) {
  const f = $('edit-form').elements;
  for (const name of ['title', 'description', 'state', 'severity', 'category', 'requester', 'assignee']) {
    f[name].value = r[name] ?? '';
  }
}

async function renderDetail(id) {
  screen('detail');
  current = await api(`/operator/records/${encodeURIComponent(id)}`);
  $('detail-title').textContent = `${current.id} · ${current.title}`;
  $('detail-state').replaceWith(Object.assign(badge(current.state), { id: 'detail-state' }));
  $('detail-meta').textContent =
    `Chamado do A: ${aTicket(current)} · criado ${new Date(current.createdAt).toLocaleString('pt-BR')}` +
    ` · atualizado ${new Date(current.updatedAt).toLocaleString('pt-BR')}`;
  $('reopen').disabled = !['RESOLVED', 'CLOSED'].includes(current.state);
  for (const b of document.querySelectorAll('[data-state]')) {
    if (b.id !== 'reopen') b.disabled = b.dataset.state === current.state;
  }
  fillForm(current);
}

// PUT é substituição completa: parte do registro atual para não apagar localização, anexos e sourceUpdatedAt
function bodyFrom(record, changes) {
  const { id, createdAt, updatedAt, ...input } = record;
  const blankToNull = (v) => (v === '' ? null : v);
  return JSON.stringify({
    ...input,
    ...changes,
    category: blankToNull(changes.category ?? input.category),
    requester: blankToNull(changes.requester ?? input.requester),
    assignee: blankToNull(changes.assignee ?? input.assignee),
  });
}

async function save(changes, message) {
  try {
    const updated = await api(`/operator/records/${encodeURIComponent(current.id)}`, {
      method: 'PUT',
      body: bodyFrom(current, changes),
    });
    await renderDetail(updated.id);
    show(message, 'ok');
  } catch (e) {
    show(e.message);
  }
}

async function route() {
  show(flash, 'ok');
  flash = null;
  const m = /^#\/records\/(.+)$/.exec(location.hash);
  try {
    if (m) await renderDetail(decodeURIComponent(m[1]));
    else await renderList();
  } catch (e) {
    show(e.message);
  }
}

function wire() {
  fillSelect($('edit-form').elements.state, STATES);
  fillSelect($('edit-form').elements.severity, SEVERITIES);

  $('refresh').addEventListener('click', route);
  $('prev-page').addEventListener('click', () => {
    page -= 1;
    route();
  });
  $('next-page').addEventListener('click', () => {
    page += 1;
    route();
  });

  for (const b of document.querySelectorAll('[data-state]')) {
    b.addEventListener('click', () => save({ state: b.dataset.state }, `Estado alterado para ${STATES[b.dataset.state]}.`));
  }

  $('delete').addEventListener('click', async () => {
    if (!confirm(`Excluir ${current.id} do B? O sync verá o registro sumir e pedirá aprovação no A.`)) return;
    try {
      await api(`/operator/records/${encodeURIComponent(current.id)}`, { method: 'DELETE' });
      flash = `${current.id} excluído.`;
      location.hash = '#/records';
    } catch (e) {
      show(e.message);
    }
  });

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
      },
      'Campos salvos.',
    );
  });

  window.addEventListener('hashchange', route);
  if (!location.hash) location.hash = '#/records';
  else route();
}

wire();
