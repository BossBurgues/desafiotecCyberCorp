import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { SystemAClient } from '../adapters/system-a/client.js';
import { BError } from '../adapters/system-b/errors.js';
import type { BRecordResponse, SystemBClient } from '../adapters/system-b/client.js';
import { findMarker, hashRecord, hashTicket, mapTicketToRecord } from '../domain/index.js';
import type { GlpiTicket, Lookups, MarkerField, RecordInput } from '../domain/types.js';
import { recordAudit } from '../infra/audit.js';
import type { JobProcessor } from '../infra/queue/runner.js';
import type { Job } from '../infra/queue/queue.js';

export interface ProcessJobDeps {
  pool: Pool;
  a: SystemAClient;
  b: SystemBClient;
  logger: Logger;
  timeZone: string;
  markerField: MarkerField;
  /** Varreduras da listagem do B sem achar o marcador antes de reenviar um create ambíguo (ADR-004). */
  uncertainScans: number;
  listPageSize: number;
  lookups?: Lookups;
}

export interface MappingRow {
  a_ticket_id: number;
  b_record_id: string | null;
  state: 'active' | 'create_uncertain' | 'quarantine' | 'deletion_requested' | 'archived';
  last_synced_hash: string | null;
  last_written_hash: string | null;
  uncertain_scans: number;
}

/**
 * O create ambíguo ainda não apareceu na listagem do B. Transitório: o job volta com backoff e varre de novo,
 * porque a listagem do B pode estar atrasada (cenário A7) ou ter pulado uma página.
 */
export class CreateUncertainError extends Error {
  public readonly scans: number;

  constructor(ticketId: number, scans: number, needed: number) {
    super(`chamado ${ticketId}: create ambíguo, marcador não achado no B (varredura ${scans} de ${needed})`);
    this.name = 'CreateUncertainError';
    this.scans = scans;
  }
}

const ACTOR = 'sync';

export async function getMapping(pool: Pick<Pool, 'query'>, ticketId: number): Promise<MappingRow | null> {
  const { rows } = await pool.query<MappingRow & { a_ticket_id: string }>(
    `SELECT a_ticket_id, b_record_id, state, last_synced_hash, last_written_hash, uncertain_scans
     FROM ticket_mapping WHERE a_ticket_id = $1`,
    [ticketId],
  );
  return rows[0] ? { ...rows[0], a_ticket_id: Number(rows[0].a_ticket_id) } : null;
}

/**
 * processJob (S3.6): leva o estado atual do chamado do A para o B, uma vez só.
 *
 * 1. Lê o chamado no A agora (nunca o payload do evento): um job atrasado nunca escreve dado velho.
 * 2. Hash igual ao último sincronizado → nada a fazer.
 * 3. Sem mapeamento → create com o marcador ⟦s:glpi-id⟧. Falha ambígua → create_uncertain: o próximo ciclo procura
 *    o marcador na listagem do B e só recria depois de N varreduras sem achar. Create às cegas nunca.
 * 4. Com mapeamento → update.
 * 5. Mapeamento e auditoria gravados na mesma transação, com last_written_hash (base do anti-eco, ADR-009).
 */
export function createProcessJob(deps: ProcessJobDeps): JobProcessor {
  const { pool, a, b } = deps;

  return async (job: Job, signal: AbortSignal) => {
    const correlationId = `job-${job.id}-${job.attempts}`;
    const log = deps.logger.child({ ticket_id: job.ticket_id, correlation_id: correlationId });

    const ticket = await a.getTicket(job.ticket_id);
    if (!ticket) {
      log.warn('chamado não existe no A: nada a sincronizar');
      await recordAudit(pool, {
        ticketId: job.ticket_id,
        direction: 'a_to_b',
        action: 'skip',
        actor: ACTOR,
        correlationId,
        outcome: 'missing_in_a',
      });
      return;
    }

    const input = mapTicketToRecord(ticket, {
      timeZone: deps.timeZone,
      markerField: deps.markerField,
      ...(deps.lookups ? { lookups: deps.lookups } : {}),
    });
    const ticketHash = hashTicket(ticket);

    let mapping = await getMapping(pool, ticket.id);

    if (mapping?.state === 'create_uncertain') {
      const found = await scanForMarker(ticket.id, correlationId);
      if (found) {
        mapping = await adopt(mapping, found, correlationId);
        log.info({ b_record_id: found.id }, 'create ambíguo resolvido: o registro estava no B, adotado sem recriar');
      } else {
        const scans = mapping.uncertain_scans + 1;
        if (scans < deps.uncertainScans) {
          await pool.query(
            `UPDATE ticket_mapping SET uncertain_scans = $2, updated_at = now() WHERE a_ticket_id = $1 AND state = 'create_uncertain'`,
            [ticket.id, scans],
          );
          throw new CreateUncertainError(ticket.id, scans, deps.uncertainScans);
        }
        log.warn({ scans }, `marcador não apareceu em ${scans} varreduras: recriando`);
        mapping = null;
      }
    }

    if (mapping && mapping.state !== 'active') {
      // quarentena, exclusão pendente e arquivado têm fluxo próprio (S3.7, S6.5): o worker não escreve no B
      log.info({ state: mapping.state }, 'mapeamento fora de active: entrega retida');
      await recordAudit(pool, {
        ticketId: ticket.id,
        direction: 'a_to_b',
        action: 'skip',
        actor: ACTOR,
        correlationId,
        outcome: `held_${mapping.state}`,
      });
      return;
    }

    if (!mapping) {
      await create(ticket, input, ticketHash, signal, correlationId, log);
      return;
    }

    if (mapping.last_synced_hash === ticketHash) {
      log.debug('hash igual ao último sincronizado: nada a fazer');
      await recordAudit(pool, {
        ticketId: ticket.id,
        direction: 'a_to_b',
        action: 'noop',
        actor: ACTOR,
        correlationId,
        request: { hash: ticketHash },
        outcome: 'unchanged',
      });
      return;
    }

    signal.throwIfAborted();
    const started = Date.now();
    const record = await b.updateRecord(mapping.b_record_id!, input, { correlationId });
    await saveActive(ticket, input, ticketHash, record.id, {
      action: 'update',
      correlationId,
      latencyMs: Date.now() - started,
    });
    log.info({ b_record_id: record.id }, 'chamado atualizado no B');
  };

  async function create(
    ticket: GlpiTicket,
    input: RecordInput,
    ticketHash: string,
    signal: AbortSignal,
    correlationId: string,
    log: Logger,
  ): Promise<void> {
    signal.throwIfAborted();
    const started = Date.now();
    let record: BRecordResponse;
    try {
      record = await b.createRecord(input, { correlationId });
    } catch (err) {
      if (err instanceof BError && err.ambiguous) {
        // O B pode ter gravado: daqui em diante só a busca pelo marcador decide se recria
        await markUncertain(ticket.id, err, correlationId);
        log.warn({ reason: err.reason }, 'create ambíguo: chamado em create_uncertain, o próximo ciclo procura o marcador');
      }
      throw err;
    }
    await saveActive(ticket, input, ticketHash, record.id, {
      action: 'create',
      correlationId,
      latencyMs: Date.now() - started,
    });
    log.info({ b_record_id: record.id }, 'chamado criado no B');
  }

  async function markUncertain(ticketId: number, err: BError, correlationId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO ticket_mapping (a_ticket_id, state, uncertain_scans, uncertain_since)
         VALUES ($1, 'create_uncertain', 0, now())
         ON CONFLICT (a_ticket_id) DO UPDATE SET
           state = 'create_uncertain', b_record_id = NULL, uncertain_scans = 0, uncertain_since = now(), updated_at = now()`,
        [ticketId],
      );
      await recordAudit(client, {
        ticketId,
        direction: 'a_to_b',
        action: 'create',
        actor: ACTOR,
        correlationId,
        response: { reason: err.reason, status: err.status ?? null },
        outcome: 'ambiguous',
      });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** Procura o marcador do chamado em todas as páginas da listagem do B. */
  async function scanForMarker(ticketId: number, correlationId: string): Promise<BRecordResponse | null> {
    for (let page = 1; ; page++) {
      const res = await b.listRecords(page, deps.listPageSize, { correlationId });
      const hit = res.items.find((r) => findMarker(r[deps.markerField]) === ticketId);
      if (hit) return hit;
      if (res.items.length === 0 || page * res.pageSize >= res.total) return null;
    }
  }

  /** Adota o registro achado pelo marcador. Hash zerado: o update logo em seguida grava o estado atual do A. */
  async function adopt(mapping: MappingRow, found: BRecordResponse, correlationId: string): Promise<MappingRow> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE ticket_mapping SET b_record_id = $2, state = 'active', last_synced_hash = NULL,
           last_written_hash = $3, uncertain_scans = 0, uncertain_since = NULL, updated_at = now()
         WHERE a_ticket_id = $1`,
        [mapping.a_ticket_id, found.id, hashRecord(found as RecordInput)],
      );
      await recordAudit(client, {
        ticketId: mapping.a_ticket_id,
        direction: 'a_to_b',
        action: 'adopt',
        actor: ACTOR,
        correlationId,
        response: { b_record_id: found.id, scans: mapping.uncertain_scans + 1 },
        outcome: 'found_by_marker',
      });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    return { ...mapping, b_record_id: found.id, state: 'active', last_synced_hash: null, uncertain_scans: 0 };
  }

  /** Mapeamento + auditoria numa transação só: ou os dois ficam, ou nenhum (o job repete e o hash decide). */
  async function saveActive(
    ticket: GlpiTicket,
    input: RecordInput,
    ticketHash: string,
    bRecordId: string,
    meta: { action: 'create' | 'update'; correlationId: string; latencyMs: number },
  ): Promise<void> {
    const writtenHash = hashRecord(input);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO ticket_mapping (a_ticket_id, b_record_id, state, last_synced_hash, last_written_hash, last_synced_date_mod_utc)
         VALUES ($1, $2, 'active', $3, $4, $5)
         ON CONFLICT (a_ticket_id) DO UPDATE SET
           b_record_history = CASE
             WHEN ticket_mapping.b_record_id IS NOT NULL AND ticket_mapping.b_record_id <> EXCLUDED.b_record_id
             THEN array_append(ticket_mapping.b_record_history, ticket_mapping.b_record_id)
             ELSE ticket_mapping.b_record_history END,
           b_record_id = EXCLUDED.b_record_id,
           state = 'active',
           last_synced_hash = EXCLUDED.last_synced_hash,
           last_written_hash = EXCLUDED.last_written_hash,
           last_synced_date_mod_utc = EXCLUDED.last_synced_date_mod_utc,
           uncertain_scans = 0, uncertain_since = NULL, updated_at = now()`,
        [ticket.id, bRecordId, ticketHash, writtenHash, input.sourceUpdatedAt ?? null],
      );
      await recordAudit(client, {
        ticketId: ticket.id,
        direction: 'a_to_b',
        action: meta.action,
        actor: ACTOR,
        correlationId: meta.correlationId,
        request: { hash: ticketHash, written_hash: writtenHash },
        response: { b_record_id: bRecordId },
        latencyMs: meta.latencyMs,
        outcome: 'ok',
      });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}
