import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { SystemAClient } from '../adapters/system-a/client.js';
import { BError } from '../adapters/system-b/errors.js';
import type { BRecordResponse, SystemBClient } from '../adapters/system-b/client.js';
import { findMarker, hashRecord, hashTicket, mapTicketToRecord, toGlpiStatus, utcToGlpiLocal } from '../domain/index.js';
import type { GlpiTicket, Lookups, MarkerField, RecordInput, RecordState } from '../domain/types.js';
import { recordAudit } from '../infra/audit.js';
import type { JobProcessor } from '../infra/queue/runner.js';
import { B_CHANGED_JOB_KIND, type Job } from '../infra/queue/queue.js';

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
  /** Relê o registro no B depois de cada escrita e só grava o hash se o B gravou de verdade (S3.8). Padrão: true. */
  verifyAfterWrite?: boolean;
  /** Catálogos do A (categoria, usuários, locais) para converter os IDs; fixos ou carregados sob demanda (com cache). */
  lookups?: Lookups | (() => Promise<Lookups>);
  /**
   * B → A leve (ADR-014). Ligado: o estado que o operador do B mudou (resolver, fechar, reabrir) é aplicado no A pelo
   * sync-bot, com uma nota de quem alterou e da solução. Desligado: o sync só não desfaz o estado que o B mudou.
   */
  bToA?: boolean;
}

export interface MappingRow {
  a_ticket_id: number;
  b_record_id: string | null;
  state: 'active' | 'create_uncertain' | 'quarantine' | 'deletion_requested' | 'archived';
  last_synced_hash: string | null;
  last_written_hash: string | null;
  /** O que o sync escreveu por último no B (migration 004). Comparado com o B atual, diz o que o B mudou. */
  last_written_record: RecordInput | null;
  uncertain_scans: number;
}

/** Campos que o sync escreve e que o B → A compara para saber o que o próprio B mudou. */
const SYNCED_FIELDS = ['title', 'description', 'state', 'severity', 'category', 'requester', 'assignee', 'location'] as const;
const FIELD_LABEL: Record<(typeof SYNCED_FIELDS)[number], string> = {
  title: 'o título',
  description: 'a descrição',
  state: 'o estado',
  severity: 'a severidade',
  category: 'a categoria',
  requester: 'o requerente',
  assignee: 'o responsável',
  location: 'o local',
};
const STATE_LABEL: Record<RecordState, string> = {
  OPEN: 'Aberto',
  IN_PROGRESS: 'Em andamento',
  ON_HOLD: 'Em espera',
  RESOLVED: 'Resolvido',
  CLOSED: 'Fechado',
};

function sameValue(x: unknown, y: unknown): boolean {
  return JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
}

/** Só os campos do RecordInput: o que o sync de fato escreveu (sem id, horários e autor do B). */
function asInput(r: RecordInput): RecordInput {
  const keys = ['title', 'description', 'state', 'severity', 'category', 'requester', 'assignee', 'location', 'sourceUpdatedAt', 'attachments', 'resolution'] as const;
  return Object.fromEntries(keys.filter((k) => r[k] !== undefined).map((k) => [k, r[k]])) as unknown as RecordInput;
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

/**
 * O B respondeu sucesso ao update, mas a leitura logo depois mostra outro conteúdo (ack sem gravar, cenário B5).
 * Transitório: o hash não é gravado, o job volta com backoff, relê o A e reenvia o estado atual.
 */
export class VerifyMismatchError extends Error {
  constructor(ticketId: number, bRecordId: string) {
    super(`chamado ${ticketId}: o B confirmou a escrita em ${bRecordId}, mas a leitura não bate com o que foi enviado`);
    this.name = 'VerifyMismatchError';
  }
}

type VerifyOutcome = 'ok' | 'mismatch' | 'missing';

const ACTOR = 'sync';

export async function getMapping(pool: Pick<Pool, 'query'>, ticketId: number): Promise<MappingRow | null> {
  const { rows } = await pool.query<MappingRow & { a_ticket_id: string }>(
    `SELECT a_ticket_id, b_record_id, state, last_synced_hash, last_written_hash, last_written_record, uncertain_scans
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
 * 4. Com mapeamento → update. Registro sumiu do B (404) → procura o marcador; senão create ambíguo.
 * 5. Verificação pós-escrita (S3.8): relê o registro no B e só segue se o conteúdo bate (ack sem gravar, B5).
 * 6. Mapeamento e auditoria gravados na mesma transação, com last_written_hash (base do anti-eco, ADR-009).
 * 7. Lixeira (ADR-015): chamado excluído no A → DELETE no B e mapeamento archived; restaurado → recria no B.
 *    Registro excluído no B (410) → lixeira do A, a não ser que o A tenha mudado o chamado depois (o A vence).
 */
export function createProcessJob(deps: ProcessJobDeps): JobProcessor {
  const { pool, a, b } = deps;
  const verifyAfterWrite = deps.verifyAfterWrite ?? true;
  const bToA = deps.bToA ?? false;

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

    const lookups = typeof deps.lookups === 'function' ? await deps.lookups() : deps.lookups;
    const toRecord = (t: GlpiTicket) =>
      mapTicketToRecord(t, { timeZone: deps.timeZone, markerField: deps.markerField, ...(lookups ? { lookups } : {}) });
    const input = toRecord(ticket);
    const ticketHash = hashTicket(ticket);

    let mapping = await getMapping(pool, ticket.id);

    if (ticket.is_deleted === 1) {
      await trashInB(ticket, ticketHash, mapping, correlationId, log);
      return;
    }
    if (mapping?.state === 'archived') {
      // Restaurado da lixeira do A: o registro antigo é lápide no B (ou nunca existiu), então nasce um novo
      log.info({ old_b_record_id: mapping.b_record_id }, 'chamado restaurado da lixeira do A: recriando no B');
      await create(ticket, input, ticketHash, signal, correlationId, log);
      return;
    }

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

    // b_changed: a varredura do B viu um registro diferente do que escrevemos; o job olha o B mesmo com o A parado
    if (mapping.last_synced_hash === ticketHash && job.kind !== B_CHANGED_JOB_KIND) {
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

    await update(ticket, input, ticketHash, mapping, signal, correlationId, log, true, toRecord);
  };

  async function update(
    ticket: GlpiTicket,
    input: RecordInput,
    ticketHash: string,
    mapping: MappingRow,
    signal: AbortSignal,
    correlationId: string,
    log: Logger,
    allowMissing = true,
    toRecord: (t: GlpiTicket) => RecordInput = (t) => mapTicketToRecord(t, { timeZone: deps.timeZone, markerField: deps.markerField }),
  ): Promise<void> {
    signal.throwIfAborted();
    const started = Date.now();

    // Ler antes de escrever (ADR-011, ADR-014): o B pode ter mudado o registro desde a nossa última escrita
    let current: BRecordResponse | null;
    try {
      current = await b.getRecord(mapping.b_record_id!, { correlationId });
    } catch (err) {
      if (allowMissing && err instanceof BError && err.reason === 'gone') {
        await deletedInB(ticket, input, ticketHash, mapping, err, signal, correlationId, log);
        return;
      }
      throw err;
    }
    if (!current) {
      if (allowMissing) {
        await recordMissing(ticket, input, ticketHash, mapping, signal, correlationId, log);
        return;
      }
      throw new BError('not_found', `GET /records/${mapping.b_record_id}: 404 logo depois de adotar`);
    }

    let toWrite = input;
    let finalTicket = ticket;
    let notes: string[] = [];
    if (mapping.last_written_hash && hashRecord(current as RecordInput) !== mapping.last_written_hash) {
      ({ ticket: finalTicket, input: toWrite, notes } = await reconcile(ticket, input, current, mapping, correlationId, log, toRecord));
    }
    // A solução é um campo do B (o operador escreve): o PUT substitui o registro inteiro, então ela vai junto
    if (current.resolution != null && toWrite.resolution === undefined) toWrite = { ...toWrite, resolution: current.resolution };
    const finalHash = hashTicket(finalTicket);

    signal.throwIfAborted();
    let recordId = current.id;
    // O B já está igual ao que escreveríamos (ex.: só o B mudou o estado, e ele vale): nenhuma escrita, nenhum eco
    if (hashRecord(current as RecordInput) !== hashRecord(toWrite) || !sameValue(current.resolution, toWrite.resolution)) {
      try {
        recordId = (await b.updateRecord(mapping.b_record_id!, toWrite, { correlationId })).id;
      } catch (err) {
        if (allowMissing && err instanceof BError && err.reason === 'not_found') {
          await recordMissing(finalTicket, toWrite, finalHash, mapping, signal, correlationId, log);
          return;
        }
        if (allowMissing && err instanceof BError && err.reason === 'gone') {
          await deletedInB(finalTicket, toWrite, finalHash, mapping, err, signal, correlationId, log);
          return;
        }
        throw err;
      }
      const outcome = await verify(ticket.id, recordId, toWrite, correlationId);
      if (outcome === 'missing' && allowMissing) {
        await recordMissing(finalTicket, toWrite, finalHash, mapping, signal, correlationId, log);
        return;
      }
      if (outcome !== 'ok') {
        log.warn({ b_record_id: recordId, outcome }, 'B confirmou o update sem gravar: o hash fica como estava e o job volta');
        throw new VerifyMismatchError(ticket.id, recordId);
      }
    }
    await saveActive(finalTicket, toWrite, finalHash, recordId, {
      action: 'update',
      correlationId,
      latencyMs: Date.now() - started,
    });
    log.info({ b_record_id: recordId }, 'chamado atualizado no B');

    // A nota vai por último, depois do mapeamento gravado: se o job repetir, a mudança já foi registrada e a nota não
    // duplica. Se a nota falhar, a mudança continua aplicada (a nota é o registro, não a garantia)
    if (bToA && notes.length > 0) {
      try {
        await a.addFollowup(ticket.id, `${notes.join('\n')} ⟦from-b:${current.id}⟧`);
      } catch (err) {
        log.warn({ err }, 'B → A: mudança aplicada, mas a nota no A falhou');
      }
    }
  }

  /**
   * B → A leve (ADR-014). O B mudou o registro desde a nossa última escrita; o que fazer com cada mudança:
   * - estado mudado só no B (resolver, fechar, reabrir): vale o do B. Com o B → A ligado, o sync-bot aplica no A;
   *   desligado, o sync só não reabre o B;
   * - estado mudado nos dois lados ao mesmo tempo: o A vence (ADR-011), com nota;
   * - outros campos mudados no B: o A é a fonte da verdade e o valor é restaurado, com nota.
   * Anti-eco (ADR-009): o mapeamento grava o hash do A depois da escrita do sync-bot, então o evento que essa escrita
   * gera no A vira no-op; e o B não recebe escrita se já está igual ao que escreveríamos.
   */
  async function reconcile(
    ticket: GlpiTicket,
    input: RecordInput,
    current: BRecordResponse,
    mapping: MappingRow,
    correlationId: string,
    log: Logger,
    toRecord: (t: GlpiTicket) => RecordInput,
  ): Promise<{ ticket: GlpiTicket; input: RecordInput; notes: string[] }> {
    const last = mapping.last_written_record;
    if (!last) return { ticket, input, notes: [] };
    const changed = SYNCED_FIELDS.filter((f) => !sameValue(current[f], last[f]));
    if (changed.length === 0) return { ticket, input, notes: [] };

    const who = current.updatedBy ?? 'autor não informado pelo B';
    const notes: string[] = [];
    let outTicket = ticket;
    let outInput = input;

    if (changed.includes('state') && current.state !== input.state) {
      const aChangedState = input.state !== last.state;
      if (!aChangedState) {
        if (bToA) {
          const updated = await a.updateStatus(ticket.id, toGlpiStatus(current.state));
          if (updated) {
            outTicket = updated;
            outInput = toRecord(updated);
          }
          notes.push(
            `Estado alterado no Sistema B por ${who}: ${STATE_LABEL[last.state]} → ${STATE_LABEL[current.state]}.` +
              (current.resolution ? ` Solução: ${current.resolution}` : ''),
          );
        } else {
          outInput = { ...outInput, state: current.state };
        }
        await recordAudit(pool, {
          ticketId: ticket.id,
          direction: 'b_to_a',
          action: 'b_state',
          actor: ACTOR,
          correlationId,
          request: { from: last.state, to: current.state, by: current.updatedBy ?? null },
          outcome: bToA ? 'applied_to_a' : 'kept_in_b',
        });
        log.info({ from: last.state, to: current.state, by: who }, bToA ? 'B → A: estado do B aplicado no A' : 'estado mudado no B mantido');
      } else {
        notes.push(
          `O Sistema B também mudou o estado para ${STATE_LABEL[current.state]} (por ${who}), ao mesmo tempo que o A mudou para ` +
            `${STATE_LABEL[input.state]}: prevaleceu o A.`,
        );
        await recordAudit(pool, {
          ticketId: ticket.id,
          direction: 'b_to_a',
          action: 'conflict',
          actor: ACTOR,
          correlationId,
          request: { a: input.state, b: current.state, by: current.updatedBy ?? null },
          outcome: 'a_wins',
        });
        log.warn({ a: input.state, b: current.state }, 'A e B mudaram o estado ao mesmo tempo: o A vence');
      }
    }

    const reverted = changed.filter((f) => f !== 'state');
    if (reverted.length > 0) {
      notes.push(`O Sistema B alterou ${reverted.map((f) => FIELD_LABEL[f]).join(', ')} (por ${who}); o A é a fonte da verdade e o valor foi restaurado.`);
      await recordAudit(pool, {
        ticketId: ticket.id,
        direction: 'b_to_a',
        action: 'b_edit',
        actor: ACTOR,
        correlationId,
        request: { fields: reverted, by: current.updatedBy ?? null },
        outcome: 'reverted',
      });
    }
    return { ticket: outTicket, input: outInput, notes };
  }

  /**
   * Chamado na lixeira do A (ADR-015): o A é o mestre da exclusão. Exclui no B (com lápide, capacidade "delete") e
   * arquiva o mapeamento com o hash do chamado excluído, para o poller não reenfileirar. Excluir de novo (410) ou um
   * registro que já não existe (404) contam como feito. Create ambíguo em aberto: procura o marcador antes.
   */
  async function trashInB(
    ticket: GlpiTicket,
    ticketHash: string,
    mapping: MappingRow | null,
    correlationId: string,
    log: Logger,
  ): Promise<void> {
    if (!mapping || mapping.state === 'archived') {
      // Nunca chegou ao B, ou já foi excluído lá: nada a escrever
      if (mapping) await archive(ticket.id, mapping.b_record_id, ticketHash);
      await recordAudit(pool, { ticketId: ticket.id, direction: 'a_to_b', action: 'noop', actor: ACTOR, correlationId, outcome: 'deleted_in_a' });
      return;
    }
    let recordId = mapping.b_record_id;
    if (!recordId && mapping.state === 'create_uncertain') recordId = (await scanForMarker(ticket.id, correlationId))?.id ?? null;
    const started = Date.now();
    const outcome = recordId ? await b.deleteRecord(recordId, { correlationId }) : 'not_found';
    await archive(ticket.id, recordId, ticketHash);
    await recordAudit(pool, {
      ticketId: ticket.id,
      direction: 'a_to_b',
      action: 'delete',
      actor: ACTOR,
      correlationId,
      response: { b_record_id: recordId },
      latencyMs: Date.now() - started,
      outcome,
    });
    log.info({ b_record_id: recordId, outcome }, 'chamado na lixeira do A: registro excluído no B');
  }

  /**
   * O registro foi excluído no B (410, com a lápide de quem e quando). Quem decide é o A (ADR-015):
   * - o A mudou o chamado depois da última sincronização (ou o B → A está desligado): o A vence e o registro é recriado;
   * - senão: o chamado vai para a lixeira do A (reversível), com a nota de quem excluiu no B.
   * A nota vai por último, como no B → A leve: se o job repetir, o chamado já está na lixeira e o caminho é o trashInB.
   */
  async function deletedInB(
    ticket: GlpiTicket,
    input: RecordInput,
    ticketHash: string,
    mapping: MappingRow,
    err: BError,
    signal: AbortSignal,
    correlationId: string,
    log: Logger,
  ): Promise<void> {
    const who = err.tombstone?.deletedBy ?? 'autor não informado pelo B';
    const when = err.tombstone ? ` em ${utcToGlpiLocal(err.tombstone.deletedAt, deps.timeZone)}` : '';
    const marker = `⟦from-b:${mapping.b_record_id}⟧`;
    const aChanged = mapping.last_synced_hash !== ticketHash;
    const request = { b_record_id: mapping.b_record_id, by: err.tombstone?.deletedBy ?? null, at: err.tombstone?.deletedAt ?? null };

    if (!bToA || aChanged) {
      await recordAudit(pool, { ticketId: ticket.id, direction: 'b_to_a', action: 'b_delete', actor: ACTOR, correlationId, request, outcome: 'a_wins' });
      log.warn({ b_record_id: mapping.b_record_id, by: who, a_changed: aChanged }, 'registro excluído no B: o A vence e o registro é recriado');
      await create(ticket, input, ticketHash, signal, correlationId, log);
      if (bToA) {
        await note(
          ticket.id,
          `O Sistema B excluiu o registro ${mapping.b_record_id} (por ${who}${when}), mas o chamado mudou no A depois da última ` +
            `sincronização: prevaleceu o A e o registro foi recriado no B. ${marker}`,
          log,
        );
      }
      return;
    }

    const trashed = await a.trashTicket(ticket.id);
    const after = trashed ? await a.getTicket(ticket.id) : null;
    await archive(ticket.id, mapping.b_record_id, after ? hashTicket(after) : ticketHash);
    await recordAudit(pool, { ticketId: ticket.id, direction: 'b_to_a', action: 'b_delete', actor: ACTOR, correlationId, request, outcome: 'trashed_in_a' });
    log.info({ b_record_id: mapping.b_record_id, by: who }, 'B → A: registro excluído no B, chamado na lixeira do A');
    await note(ticket.id, `Excluído no Sistema B por ${who}${when}: o chamado foi para a lixeira do A (restaurar recria o registro no B). ${marker}`, log);
  }

  async function note(ticketId: number, content: string, log: Logger): Promise<void> {
    try {
      await a.addFollowup(ticketId, content);
    } catch (err) {
      log.warn({ err }, 'B → A: mudança aplicada, mas a nota no A falhou');
    }
  }

  /** Mapeamento arquivado: o registro do B foi excluído. O b_record_id fica para a história; o hash evita reenfileirar. */
  async function archive(ticketId: number, bRecordId: string | null, ticketHash: string): Promise<void> {
    await pool.query(
      `UPDATE ticket_mapping SET state = 'archived', b_record_id = $2, last_synced_hash = $3,
         uncertain_scans = 0, uncertain_since = NULL, updated_at = now()
       WHERE a_ticket_id = $1`,
      [ticketId, bRecordId, ticketHash],
    );
  }

  /**
   * O registro mapeado sumiu do B (404 no update ou na leitura de verificação). O A é a fonte da verdade:
   * procura o marcador na listagem (o registro pode ter ganhado outro ID) e adota; senão segue o caminho do create
   * ambíguo, que só recria depois de N varreduras sem achar (ADR-004). Nunca recria às cegas.
   */
  async function recordMissing(
    ticket: GlpiTicket,
    input: RecordInput,
    ticketHash: string,
    mapping: MappingRow,
    signal: AbortSignal,
    correlationId: string,
    log: Logger,
  ): Promise<void> {
    await recordAudit(pool, {
      ticketId: ticket.id,
      direction: 'a_to_b',
      action: 'record_missing',
      actor: ACTOR,
      correlationId,
      response: { b_record_id: mapping.b_record_id },
      outcome: 'not_found',
    });
    const found = await scanForMarker(ticket.id, correlationId);
    if (found && found.id !== mapping.b_record_id) {
      const adopted = await adopt(mapping, found, correlationId);
      log.warn({ old_b_record_id: mapping.b_record_id, b_record_id: found.id }, 'registro sumiu do B, marcador achado em outro ID: adotado');
      await update(ticket, input, ticketHash, adopted, signal, correlationId, log, false);
      return;
    }
    const scans = 1;
    await pool.query(
      `UPDATE ticket_mapping SET state = 'create_uncertain',
         b_record_history = CASE WHEN b_record_id IS NULL THEN b_record_history ELSE array_append(b_record_history, b_record_id) END,
         b_record_id = NULL, uncertain_scans = $2, uncertain_since = now(), updated_at = now()
       WHERE a_ticket_id = $1`,
      [ticket.id, scans],
    );
    if (scans < deps.uncertainScans) {
      log.warn({ old_b_record_id: mapping.b_record_id }, 'registro sumiu do B e o marcador não está na listagem: create_uncertain');
      throw new CreateUncertainError(ticket.id, scans, deps.uncertainScans);
    }
    log.warn({ old_b_record_id: mapping.b_record_id }, 'registro sumiu do B: recriando');
    await create(ticket, input, ticketHash, signal, correlationId, log);
  }

  /** Lê o registro de volta e compara o hash do conteúdo (ignora id e horários do B, cenário C6). */
  async function verify(ticketId: number, recordId: string, input: RecordInput, correlationId: string): Promise<VerifyOutcome> {
    if (!verifyAfterWrite) return 'ok';
    const read = await b.getRecord(recordId, { correlationId });
    const outcome: VerifyOutcome = !read ? 'missing' : hashRecord(read as RecordInput) === hashRecord(input) ? 'ok' : 'mismatch';
    if (outcome !== 'ok') {
      await recordAudit(pool, {
        ticketId,
        direction: 'a_to_b',
        action: 'verify',
        actor: ACTOR,
        correlationId,
        response: { b_record_id: recordId },
        outcome,
      });
    }
    return outcome;
  }

  async function create(
    ticket: GlpiTicket,
    input: RecordInput,
    ticketHash: string,
    signal: AbortSignal,
    correlationId: string,
    log: Logger,
  ): Promise<void> {
    signal.throwIfAborted();
    // Intenção gravada ANTES de chamar o B: se o processo morrer entre o create e o mapeamento (B3), o retry
    // encontra create_uncertain e procura o marcador em vez de criar de novo
    await recordIntent(ticket.id);
    const started = Date.now();
    let record: BRecordResponse;
    try {
      record = await b.createRecord(input, { correlationId });
    } catch (err) {
      if (err instanceof BError && !err.ambiguous) {
        // O B recusou ou nem recebeu (429, 4xx, disjuntor): com certeza não gravou, a intenção sai
        await clearIntent(ticket.id);
      } else {
        // O B pode ter gravado (timeout, 5xx, 200 com erro, drift, erro desconhecido): só a busca pelo marcador decide
        await auditAmbiguous(ticket.id, err, correlationId);
        log.warn(
          { reason: err instanceof BError ? err.reason : 'unknown' },
          'create ambíguo: chamado em create_uncertain, o próximo ciclo procura o marcador',
        );
      }
      throw err;
    }
    const outcome = await verify(ticket.id, record.id, input, correlationId);
    if (outcome !== 'ok') {
      // 201 que não aparece (ack sem gravar) ou aparece diferente. Pode ser gravação atrasada: recriar agora arriscaria
      // duplicata. A intenção já está gravada, então o próximo ciclo procura o marcador e só recria depois de N varreduras
      log.warn({ b_record_id: record.id, outcome }, 'create confirmado pelo B não bate com a leitura: create_uncertain');
      throw new CreateUncertainError(ticket.id, 0, deps.uncertainScans);
    }
    await saveActive(ticket, input, ticketHash, record.id, {
      action: 'create',
      correlationId,
      latencyMs: Date.now() - started,
    });
    log.info({ b_record_id: record.id }, 'chamado criado no B');
  }

  async function recordIntent(ticketId: number): Promise<void> {
    await pool.query(
      `INSERT INTO ticket_mapping (a_ticket_id, state, uncertain_scans, uncertain_since)
       VALUES ($1, 'create_uncertain', 0, now())
       ON CONFLICT (a_ticket_id) DO UPDATE SET
         state = 'create_uncertain',
         b_record_history = CASE WHEN ticket_mapping.b_record_id IS NULL THEN ticket_mapping.b_record_history
           ELSE array_append(ticket_mapping.b_record_history, ticket_mapping.b_record_id) END,
         b_record_id = NULL, uncertain_scans = 0, uncertain_since = now(), updated_at = now()`,
      [ticketId],
    );
  }

  async function clearIntent(ticketId: number): Promise<void> {
    await pool.query(`DELETE FROM ticket_mapping WHERE a_ticket_id = $1 AND state = 'create_uncertain' AND b_record_id IS NULL`, [
      ticketId,
    ]);
  }

  async function auditAmbiguous(ticketId: number, err: unknown, correlationId: string): Promise<void> {
    await recordAudit(pool, {
      ticketId,
      direction: 'a_to_b',
      action: 'create',
      actor: ACTOR,
      correlationId,
      response:
        err instanceof BError
          ? { reason: err.reason, status: err.status ?? null }
          : { reason: 'unknown', error: err instanceof Error ? err.name : 'Error' },
      outcome: 'ambiguous',
    });
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
           last_written_hash = $3, last_written_record = $4, uncertain_scans = 0, uncertain_since = NULL, updated_at = now()
         WHERE a_ticket_id = $1`,
        [mapping.a_ticket_id, found.id, hashRecord(found as RecordInput), JSON.stringify(asInput(found as RecordInput))],
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
    return {
      ...mapping,
      b_record_id: found.id,
      state: 'active',
      last_synced_hash: null,
      last_written_hash: hashRecord(found as RecordInput),
      last_written_record: asInput(found as RecordInput),
      uncertain_scans: 0,
    };
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
        `INSERT INTO ticket_mapping (a_ticket_id, b_record_id, state, last_synced_hash, last_written_hash, last_synced_date_mod_utc, last_written_record)
         VALUES ($1, $2, 'active', $3, $4, $5, $6)
         ON CONFLICT (a_ticket_id) DO UPDATE SET
           b_record_history = CASE
             WHEN ticket_mapping.b_record_id IS NOT NULL AND ticket_mapping.b_record_id <> EXCLUDED.b_record_id
             THEN array_append(ticket_mapping.b_record_history, ticket_mapping.b_record_id)
             ELSE ticket_mapping.b_record_history END,
           b_record_id = EXCLUDED.b_record_id,
           state = 'active',
           last_synced_hash = EXCLUDED.last_synced_hash,
           last_written_hash = EXCLUDED.last_written_hash,
           last_written_record = EXCLUDED.last_written_record,
           last_synced_date_mod_utc = EXCLUDED.last_synced_date_mod_utc,
           uncertain_scans = 0, uncertain_since = NULL, updated_at = now()`,
        [ticket.id, bRecordId, ticketHash, writtenHash, input.sourceUpdatedAt ?? null, JSON.stringify(asInput(input))],
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
