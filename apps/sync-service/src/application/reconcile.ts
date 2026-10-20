import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { BRecordResponse, SystemBClient } from '../adapters/system-b/client.js';
import { findMarker, hashRecord } from '../domain/index.js';
import type { MarkerField, RecordInput } from '../domain/types.js';
import { recordAudit } from '../infra/audit.js';
import { asInput } from './process-job.js';

export interface ReconcileDeps {
  pool: Pool;
  b: SystemBClient;
  logger: Logger;
  markerField: MarkerField;
  pageSize: number;
}

export interface ReconcileResult {
  seen: number;
  /** Registros com marcador e sem mapeamento, adotados agora. */
  adopted: number;
  /** Chamados com mais de um registro com o mesmo marcador no B (duplicata antiga: fica o mais antigo). */
  duplicated: number[];
  /** A listagem trouxe todos os registros (IDs distintos = total). Listagem pulada ou repetida → false. */
  complete: boolean;
}

/**
 * Reconciliação pelo marcador: antes do worker criar qualquer coisa, todo registro do B com ⟦s:glpi-id⟧ e sem
 * mapeamento é adotado. Cobre a perda do banco do sync (ou a restauração de um backup antigo): sem ela, o poller
 * relê o A desde o início, o worker não acha mapeamento e cria tudo de novo no B (duplicata).
 *
 * Só insere mapeamento que não existe (ON CONFLICT DO NOTHING): create_uncertain, arquivado e ativo seguem o fluxo
 * deles. Adotar é sempre seguro, então uma listagem que falha no meio mantém o que já adotou; quem chama repete até
 * `complete`. O hash do último sincronizado fica nulo: o próximo job do chamado grava o estado atual do A.
 */
export async function reconcileMappings(deps: ReconcileDeps): Promise<ReconcileResult> {
  const byTicket = new Map<number, BRecordResponse[]>();
  const ids = new Set<string>();
  let total = 0;
  for (let page = 1; ; page++) {
    const res = await deps.b.listRecords(page, deps.pageSize, { correlationId: 'reconcile' });
    total = res.total;
    for (const rec of res.items) {
      if (ids.has(rec.id)) continue;
      ids.add(rec.id);
      const ticketId = findMarker(rec[deps.markerField]);
      if (ticketId !== null) byTicket.set(ticketId, [...(byTicket.get(ticketId) ?? []), rec]);
    }
    if (res.items.length === 0 || page * res.pageSize >= res.total) break;
  }

  let adopted = 0;
  const duplicated: number[] = [];
  for (const [ticketId, recs] of byTicket) {
    // Duplicata de antes (nunca removida pelo sync): o registro original é o mais antigo
    const [rec] = [...recs].sort((x, y) => (x.createdAt ?? '').localeCompare(y.createdAt ?? '') ||x.id.localeCompare(y.id));
    if (recs.length > 1) duplicated.push(ticketId);
    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        `INSERT INTO ticket_mapping (a_ticket_id, b_record_id, state, last_synced_hash, last_written_hash, last_written_record)
         VALUES ($1, $2, 'active', NULL, $3, $4)
         ON CONFLICT DO NOTHING`,
        [ticketId, rec!.id, hashRecord(rec as RecordInput), JSON.stringify(asInput(rec as RecordInput))],
      );
      if (rowCount === 1) {
        adopted++;
        await recordAudit(client, {
          ticketId,
          direction: 'a_to_b',
          action: 'adopt',
          actor: 'sync',
          correlationId: 'reconcile',
          response: { b_record_id: rec!.id },
          outcome: 'reconciled_by_marker',
        });
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  const result = { seen: ids.size, adopted, duplicated, complete: ids.size >= total };
  if (adopted > 0 || duplicated.length > 0 || !result.complete) {
    deps.logger.warn(result, 'reconciliação pelo marcador: registros do B sem mapeamento adotados');
  }
  return result;
}

/**
 * Repete a reconciliação até uma listagem completa do B. Enquanto isso o worker fica parado (os eventos continuam
 * gravados na fila, nada se perde); depois, `isDone()` libera o worker.
 */
export function startReconcile(deps: ReconcileDeps & { retryMs: number; isReady: () => boolean }): {
  isDone: () => boolean;
  stop: () => void;
} {
  let done = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const attempt = async () => {
    try {
      if (deps.isReady() && (await reconcileMappings(deps)).complete) {
        done = true;
        deps.logger.info('reconciliação pelo marcador concluída: worker liberado');
        return;
      }
    } catch (err) {
      deps.logger.warn({ err }, 'reconciliação pelo marcador falhou; tenta de novo');
    }
    if (!stopped) timer = setTimeout(() => void attempt(), deps.retryMs);
  };
  void attempt();
  return {
    isDone: () => done,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
