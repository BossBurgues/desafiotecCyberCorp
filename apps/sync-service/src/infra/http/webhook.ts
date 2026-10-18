import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { enqueue } from '../queue/queue.js';

export const WEBHOOK_PATH = '/webhooks/system-a';

export type SignatureCheck = 'ok' | 'missing' | 'stale' | 'bad_signature';

/**
 * Confere a assinatura do A: sha256=HMAC(segredo, "<timestamp>.<corpo cru>"). O timestamp entra na assinatura, então
 * um evento capturado não pode ser reenviado com timestamp novo; fora da janela (5 min) é recusado (anti-replay).
 */
export function verifySignature(input: {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  nowMs: number;
  windowMs: number;
}): SignatureCheck {
  const { timestamp, signature } = input;
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return 'missing';
  const expected = `sha256=${createHmac('sha256', input.secret).update(`${timestamp}.${input.rawBody}`, 'utf8').digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // Comparação em tempo constante: o tempo de resposta não revela quantos caracteres bateram
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'bad_signature';
  if (Math.abs(input.nowMs - Number(timestamp) * 1000) > input.windowMs) return 'stale';
  return 'ok';
}

// O evento é só um sinal (ADR-005): o sync usa ticket_id e event_id e relê o A. O resto é informativo
const eventSchema = z.object({
  schema_version: z.literal(1),
  event_id: z.string().min(1).max(64),
  type: z.literal('ticket.changed'),
  ticket_id: z.number().int().min(1),
  action: z.enum(['created', 'updated']),
  occurred_at: z.string(),
  date_mod: z.string().optional(),
});

/**
 * Receptor do webhook ticket.changed (S3.4). Persiste o evento e enfileira o job na mesma transação ANTES de
 * responder 200: se o sync cair depois do 200, o job já está no Postgres. Evento repetido (mesmo event_id) é aceito
 * e ignorado, e o job do chamado aglutina (um por chamado).
 */
export function webhookPlugin(options: { pool: Pool; secret: string; windowMs: number; now?: () => number }): FastifyPluginAsync {
  const now = options.now ?? Date.now;

  return async (scope) => {
    // Corpo cru: a assinatura é sobre os bytes recebidos, não sobre o JSON reserializado
    scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_req, body, done) =>
      done(null, body),
    );

    scope.post(WEBHOOK_PATH, async (req, reply) => {
      const rawBody = typeof req.body === 'string' ? req.body : '';
      const header = (name: string) => {
        const v = req.headers[name];
        return Array.isArray(v) ? v[0] : v;
      };
      const check = verifySignature({
        secret: options.secret,
        timestamp: header('x-timestamp'),
        signature: header('x-signature-256'),
        rawBody,
        nowMs: now(),
        windowMs: options.windowMs,
      });
      if (check !== 'ok') {
        req.log.warn({ check }, 'webhook recusado');
        await recordAudit(options.pool, {
          ticketId: null,
          direction: 'inbound',
          action: 'webhook',
          actor: 'system-a',
          correlationId: req.id,
          response: { status: 401, check },
          outcome: 'rejected',
        });
        return reply.code(401).send({ error: 'invalid_signature', message: 'Assinatura ausente, inválida ou fora da janela.' });
      }

      let json: unknown;
      try {
        json = JSON.parse(rawBody);
      } catch {
        return reply.code(400).send({ error: 'invalid_body', message: 'Corpo não é JSON.' });
      }
      const parsed = eventSchema.safeParse(json);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_event', message: 'Evento fora do contrato ticket.changed.' });
      }
      const event = parsed.data;

      const client = await options.pool.connect();
      try {
        await client.query('BEGIN');
        const inserted = await client.query(
          `INSERT INTO inbound_events (source, ticket_id, payload, event_id) VALUES ('webhook', $1, $2, $3)
           ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING`,
          [event.ticket_id, event, event.event_id],
        );
        const duplicate = inserted.rowCount === 0;
        const job = duplicate ? null : await enqueue(client, event.ticket_id);
        await client.query('COMMIT');
        req.log.info({ ticket_id: event.ticket_id, event_id: event.event_id, duplicate, job_id: job?.id }, 'webhook aceito');
        return reply.code(200).send({ accepted: true, duplicate });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    });
  };
}
