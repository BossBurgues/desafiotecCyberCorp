// Ferramentas dos E2E: falam com A, B e sync pelas portas locais do compose e controlam os containers.
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const A_URL = process.env.E2E_A_URL ?? 'http://127.0.0.1:3001';
export const B_URL = process.env.E2E_B_URL ?? 'http://127.0.0.1:5002';
export const SYNC_URL = process.env.E2E_SYNC_URL ?? 'http://127.0.0.1:3000';
const APP_TOKEN = process.env.A_APP_TOKEN ?? 'dev-app-token';
const TECNICO_PASSWORD = process.env.A_TECNICO_PASSWORD ?? 'dev-tecnico-password';
const HMAC_SECRET = process.env.HMAC_SECRET ?? 'dev-hmac-secret-troque-em-producao-0000';
// Login do dashboard (S5.3): as credenciais fixas do infra/docker-compose.e2e.yml
const DASHBOARD_AUTH = `Basic ${Buffer.from(
  `${process.env.E2E_DASHBOARD_USER ?? 'e2e'}:${process.env.E2E_DASHBOARD_PASSWORD ?? 'e2e-senha-fixa-123'}`,
).toString('base64')}`;

/** docker compose com os mesmos arquivos e projeto que a CI usa para subir o ambiente. */
export function compose(...args) {
  return composeWith([], ...args);
}

/** Igual ao compose(), com overrides a mais por cima (ex.: o A sem webhook do cenário B2). */
export function composeWith(extraFiles, ...args) {
  return execFileSync(
    'docker',
    [
      'compose',
      '-f', resolve(ROOT, 'infra/docker-compose.yml'),
      '-f', resolve(ROOT, 'infra/docker-compose.e2e.yml'),
      ...extraFiles.flatMap((f) => ['-f', resolve(ROOT, f)]),
      '--env-file', resolve(ROOT, process.env.E2E_ENV_FILE ?? '.env.example'),
      ...args,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
  );
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Repete `fn` até devolver algo verdadeiro ou estourar o prazo. Erros no meio contam como "ainda não". */
export async function waitFor(fn, { timeoutMs = 60_000, intervalMs = 1_000, what = 'condição' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
      last = v;
    } catch (err) {
      if (err?.fatal) throw err;
      last = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timeout esperando ${what}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Sessão do Técnico no A (perfil que cria e edita). */
export async function tecnico() {
  const auth = `Basic ${Buffer.from(`tecnico:${TECNICO_PASSWORD}`).toString('base64')}`;
  const res = await fetch(`${A_URL}/apirest.php/initSession`, { headers: { 'App-Token': APP_TOKEN, Authorization: auth } });
  const { session_token: token } = await json(res);
  const headers = { 'App-Token': APP_TOKEN, 'Session-Token': token, 'Content-Type': 'application/json' };
  return {
    async create(input) {
      const r = await fetch(`${A_URL}/apirest.php/Ticket`, { method: 'POST', headers, body: JSON.stringify({ input }) });
      if (r.status !== 201) throw new Error(`POST /Ticket: ${r.status} ${JSON.stringify(await json(r))}`);
      return json(r);
    },
    async update(id, input) {
      const r = await fetch(`${A_URL}/apirest.php/Ticket/${id}`, { method: 'PUT', headers, body: JSON.stringify({ input }) });
      if (!r.ok) throw new Error(`PUT /Ticket/${id}: ${r.status}`);
      return json(r);
    },
  };
}

/** Todos os registros do B pela rota do operador (fora do caos), agrupados pelo ID do A do marcador. */
export async function recordsByTicket() {
  const all = [];
  for (let page = 1; ; page++) {
    const r = await fetch(`${B_URL}/operator/records?page=${page}&pageSize=200`);
    if (!r.ok) throw new Error(`GET /operator/records: ${r.status}`);
    const body = await json(r);
    all.push(...body.items);
    if (page * body.pageSize >= body.total || body.items.length === 0) break;
  }
  const by = new Map();
  for (const rec of all) {
    const m = /⟦s:glpi-(\d+)⟧\s*$/.exec(rec.description);
    if (!m) continue;
    const id = Number(m[1]);
    by.set(id, [...(by.get(id) ?? []), rec]);
  }
  return by;
}

export async function summary() {
  const r = await fetch(`${SYNC_URL}/api/dashboard/summary`, { headers: { authorization: DASHBOARD_AUTH } });
  if (!r.ok) throw new Error(`summary: ${r.status}`);
  return json(r);
}

/** O caos agressivo do infra/docker-compose.e2e.yml, para voltar a ele depois de um cenário que o troca. */
export const AGGRESSIVE_CHAOS = {
  seed: 42,
  latencyMs: 50,
  errorRate: 0.1,
  timeoutRate: 0.05,
  timeoutMs: 8000,
  commitThenFailRate: 0.05,
  ackWithoutPersistRate: 0.03,
  okWithErrorBodyRate: 0.05,
  rateLimitRate: 0.05,
  pageRepeatRate: 0.05,
  pageSkipRate: 0.05,
  listDelayMs: 3000,
};

/** Troca a configuração inteira do caos do B (campo ausente = desligado) pelo dashboard do sync. */
export async function setChaos(options = {}) {
  const r = await fetch(`${SYNC_URL}/api/dashboard/chaos`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: DASHBOARD_AUTH },
    body: JSON.stringify(options),
  });
  if (!r.ok) throw new Error(`PUT chaos: ${r.status} ${JSON.stringify(await json(r))}`);
}

/**
 * Espera cada chamado aparecer no B exatamente uma vez, com o título esperado.
 * Falha na hora se aparecer duplicata (a garantia que nunca pode quebrar, nem de passagem).
 */
export async function expectSyncedOnce(expected, { timeoutMs = 90_000 } = {}) {
  return waitFor(
    async () => {
      const by = await recordsByTicket();
      for (const [id, recs] of by) {
        if (recs.length > 1) throw Object.assign(new Error(`chamado ${id} duplicado no B: ${recs.map((r) => r.id).join(', ')}`), { fatal: true });
      }
      return [...expected].every(([id, title]) => by.get(id)?.[0]?.title === title);
    },
    { timeoutMs, what: 'todos os chamados no B, uma vez cada, atualizados' },
  ).catch(async (err) => {
    const by = await recordsByTicket().catch(() => new Map());
    const dup = [...by].filter(([, r]) => r.length > 1).map(([id]) => id);
    const missing = [...expected.keys()].filter((id) => !by.has(id));
    const stale = [...expected].filter(([id, t]) => by.get(id) && by.get(id)[0].title !== t).map(([id]) => id);
    throw new Error(`${err.message} | duplicados=${dup} faltando=${missing} desatualizados=${stale}`);
  });
}

/** Espera o sync responder /ready (Postgres, A e B de pé). */
export function waitReady(timeoutMs = 90_000) {
  return waitFor(async () => (await fetch(`${SYNC_URL}/ready`)).ok, { timeoutMs, what: 'sync /ready' });
}

/** Entrega um ticket.changed ao sync como o A faria (assinado com o HMAC de teste). Para reentregar eventos velhos (C1). */
export async function sendWebhook(ticketId, { action = 'updated', dateMod } = {}) {
  const body = JSON.stringify({
    schema_version: 1,
    event_id: randomUUID(),
    type: 'ticket.changed',
    ticket_id: ticketId,
    action,
    occurred_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...(dateMod ? { date_mod: dateMod } : {}),
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `sha256=${createHmac('sha256', HMAC_SECRET).update(`${ts}.${body}`, 'utf8').digest('hex')}`;
  const r = await fetch(`${SYNC_URL}/webhooks/system-a`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-timestamp': ts, 'x-signature-256': sig },
    body,
  });
  if (r.status !== 200) throw new Error(`webhook: ${r.status} ${JSON.stringify(await json(r))}`);
}

/** Espera a fila do sync esvaziar (nada pendente nem rodando). */
export function waitQueueIdle(timeoutMs = 60_000) {
  return waitFor(
    async () => {
      const { jobs } = await summary();
      return jobs.pending === 0 && jobs.running === 0;
    },
    { timeoutMs, what: 'fila do sync vazia' },
  );
}
