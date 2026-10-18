import { createHmac, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pollOnce } from '../../src/application/poller.js';
import { hashTicket } from '../../src/domain/index.js';
import { migrate } from '../../src/infra/db/migrate.js';
import { createReadiness } from '../../src/infra/http/readiness.js';
import { buildServer } from '../../src/infra/http/server.js';
import { WEBHOOK_PATH, webhookPlugin } from '../../src/infra/http/webhook.js';
import { fakeA, ticket } from '../fakes.js';
import { memoryLogger } from '../helpers.js';
import { TEST_DATABASE_URL, isolatedPool } from './db.js';

const SECRET = 'segredo-hmac-de-teste-0000';
const NOW = Date.parse('2026-10-18T13:00:00Z');
const TZ = 'America/Sao_Paulo';

function signed(body: object, opts: { ts?: number; secret?: string } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor((opts.ts ?? NOW) / 1000));
  const sig = `sha256=${createHmac('sha256', opts.secret ?? SECRET).update(`${ts}.${raw}`).digest('hex')}`;
  return { payload: raw, headers: { 'content-type': 'application/json', 'x-timestamp': ts, 'x-signature-256': sig } };
}

function event(ticketId: number, eventId = randomUUID()) {
  return {
    schema_version: 1,
    event_id: eventId,
    type: 'ticket.changed',
    ticket_id: ticketId,
    action: 'updated',
    occurred_at: '2026-10-18T13:00:00Z',
  };
}

describe.skipIf(!TEST_DATABASE_URL)('entrada: webhook HMAC + poller (S3.4)', () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  const { logger } = memoryLogger('silent');

  beforeEach(async () => {
    ({ pool, drop } = await isolatedPool());
    await migrate(pool, logger);
  });
  afterEach(async () => drop());

  const jobs = async () => (await pool.query('SELECT ticket_id, status FROM sync_jobs ORDER BY ticket_id')).rows;
  const events = async () => (await pool.query('SELECT source, ticket_id FROM inbound_events ORDER BY id')).rows;

  describe('webhook', () => {
    const server = () =>
      buildServer({
        logger,
        readiness: createReadiness({ timeoutMs: 100, checks: {} }),
        plugins: [webhookPlugin({ pool, secret: SECRET, windowMs: 300_000, now: () => NOW })],
      });

    it('assinatura válida: grava o evento e enfileira o job antes de responder 200', async () => {
      const res = await server().inject({ method: 'POST', url: WEBHOOK_PATH, ...signed(event(7)) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ accepted: true, duplicate: false });
      expect(await events()).toEqual([{ source: 'webhook', ticket_id: '7' }]);
      expect(await jobs()).toEqual([{ ticket_id: '7', status: 'pending' }]);
    });

    it('o mesmo evento entregue de novo é aceito e ignorado: 1 evento, 1 job', async () => {
      const app = server();
      const e = event(7);
      for (let i = 0; i < 3; i++) {
        const res = await app.inject({ method: 'POST', url: WEBHOOK_PATH, ...signed(e) });
        expect(res.statusCode).toBe(200);
      }
      expect(await events()).toHaveLength(1);
      expect(await jobs()).toHaveLength(1);
    });

    it('eventos diferentes do mesmo chamado aglutinam num job só', async () => {
      const app = server();
      for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: WEBHOOK_PATH, ...signed(event(7)) });
      expect(await events()).toHaveLength(5);
      expect(await jobs()).toEqual([{ ticket_id: '7', status: 'pending' }]);
    });

    it.each([
      ['segredo errado', () => signed(event(7), { secret: 'outro-segredo-qualquer-000' })],
      ['timestamp fora da janela de 5 min (replay)', () => signed(event(7), { ts: NOW - 301_000 })],
      ['sem cabeçalhos de assinatura', () => ({ payload: JSON.stringify(event(7)), headers: { 'content-type': 'application/json' } })],
    ])('%s → 401, nada enfileirado e recusa auditada', async (_name, build) => {
      const res = await server().inject({ method: 'POST', url: WEBHOOK_PATH, ...build() });
      expect(res.statusCode).toBe(401);
      expect(await jobs()).toEqual([]);
      const audit = (await pool.query(`SELECT action, outcome FROM audit_log`)).rows;
      expect(audit).toEqual([{ action: 'webhook', outcome: 'rejected' }]);
    });

    it('corpo alterado depois de assinado → 401', async () => {
      const s = signed(event(7));
      const res = await server().inject({ method: 'POST', url: WEBHOOK_PATH, ...s, payload: s.payload.replace('"ticket_id":7', '"ticket_id":8') });
      expect(res.statusCode).toBe(401);
    });

    it('evento assinado mas fora do contrato → 400', async () => {
      const res = await server().inject({ method: 'POST', url: WEBHOOK_PATH, ...signed({ ...event(7), ticket_id: 'x' }) });
      expect(res.statusCode).toBe(400);
      expect(await jobs()).toEqual([]);
    });
  });

  describe('poller', () => {
    const deps = (A: ReturnType<typeof fakeA>, now = NOW) => ({
      pool,
      a: A.client,
      logger,
      timeZone: TZ,
      overlapMs: 120_000,
      pageSize: 2,
      now: () => now,
    });

    it('primeira execução: enfileira todos os chamados, paginando, e grava o checkpoint em UTC', async () => {
      const A = fakeA([1, 2, 3, 4, 5].map((id) => ticket(id, { date_mod: `2026-10-18 09:5${id}:00` })));
      const r = await pollOnce(deps(A));
      expect(r).toMatchObject({ seen: 5, enqueued: 5, checkpoint: '2026-10-18T12:55:00.000Z' });
      expect(await jobs()).toHaveLength(5);
    });

    it('sobreposição de 2 min: relê o que mudou logo antes do checkpoint (commit atrasado não se perde)', async () => {
      const A = fakeA([ticket(1, { date_mod: '2026-10-18 09:59:00' })]);
      await pollOnce(deps(A));
      await pool.query(`UPDATE sync_jobs SET status = 'done'`);
      // Chamado 2 commitou depois do poll, mas com date_mod 1 min anterior ao checkpoint
      A.put(ticket(2, { date_mod: '2026-10-18 09:58:00' }));
      const r = await pollOnce(deps(A));
      expect(r.enqueued).toBe(2);
      expect((await jobs()).filter((j) => j.status === 'pending').map((j) => j.ticket_id)).toEqual(['1', '2']);
    });

    it('chamado já sincronizado com o mesmo hash não é reenfileirado; mudança no mesmo segundo é (B12)', async () => {
      const t1 = ticket(1, { date_mod: '2026-10-18 09:59:00' });
      const t2 = ticket(2, { date_mod: '2026-10-18 09:59:00' });
      const A = fakeA([t1, t2]);
      await pool.query(
        `INSERT INTO ticket_mapping (a_ticket_id, b_record_id, state, last_synced_hash) VALUES (1, 'B-1', 'active', $1), (2, 'B-2', 'active', $2)`,
        [hashTicket(t1), hashTicket(t2)],
      );
      expect((await pollOnce(deps(A))).enqueued).toBe(0);
      // Segundo update no mesmo segundo: date_mod igual, dado diferente
      A.put({ ...t2, name: 'mudou no mesmo segundo' });
      expect((await pollOnce(deps(A))).enqueued).toBe(1);
      expect((await jobs()).map((j) => j.ticket_id)).toEqual(['2']);
    });

    it('chamado com job pendente não gera sinal novo a cada ciclo; com job rodando gera (rerun)', async () => {
      const A = fakeA([ticket(1)]);
      await pollOnce(deps(A));
      await pollOnce(deps(A));
      expect(await events()).toHaveLength(1);
      await pool.query(`UPDATE sync_jobs SET status = 'running', lease_token = gen_random_uuid(), locked_until = now() + interval '1 minute'`);
      await pollOnce(deps(A));
      expect(await events()).toHaveLength(2);
      expect((await pool.query('SELECT rerun FROM sync_jobs')).rows).toEqual([{ rerun: true }]);
    });

    it('webhook e poll da mesma mudança viram um job só', async () => {
      const A = fakeA([ticket(7)]);
      const app = buildServer({
        logger,
        readiness: createReadiness({ timeoutMs: 100, checks: {} }),
        plugins: [webhookPlugin({ pool, secret: SECRET, windowMs: 300_000, now: () => NOW })],
      });
      await app.inject({ method: 'POST', url: WEBHOOK_PATH, ...signed(event(7)) });
      await pollOnce(deps(A));
      // O poll viu o job pendente do webhook e não registrou outro sinal
      expect(await events()).toEqual([{ source: 'webhook', ticket_id: '7' }]);
      expect(await jobs()).toEqual([{ ticket_id: '7', status: 'pending' }]);
    });

    it('date_mod no futuro não empurra o checkpoint além de agora', async () => {
      const A = fakeA([ticket(1, { date_mod: '2026-10-18 23:00:00' })]);
      const r = await pollOnce(deps(A));
      expect(r.checkpoint).toBe(new Date(NOW).toISOString());
    });
  });
});
