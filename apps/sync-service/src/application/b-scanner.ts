import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { SystemBClient } from '../adapters/system-b/client.js';
import { BError } from '../adapters/system-b/errors.js';
import { findMarker, hashRecord } from '../domain/index.js';
import type { MarkerField, RecordInput } from '../domain/types.js';
import { B_CHANGED_JOB_KIND, enqueue } from '../infra/queue/queue.js';
import { startLoop, type Loop } from '../infra/loop.js';

export interface BScannerDeps {
  pool: Pool;
  b: SystemBClient;
  logger: Logger;
  markerField: MarkerField;
  pageSize: number;
}

/** Teto de GETs de confirmação por ciclo: uma listagem que veio curta não pode virar uma rajada contra um B instável. */
export const MAX_SUSPECTS_PER_SCAN = 25;

export interface ScanResult {
  seen: number;
  changed: number;
  /** Registros mapeados que não apareceram na listagem e o GET confirmou que sumiram (410 excluído, 404 perdido). */
  missing: number;
}

/**
 * B → A leve (ADR-014): o B não avisa ninguém, então o sync olha. Percorre a listagem do B e, para cada registro
 * mapeado cujo conteúdo não é mais o que o sync escreveu (hash ≠ last_written_hash), enfileira um job b_changed.
 * Quem decide o que fazer é o processJob, com o mesmo lease, retry e auditoria do A → B.
 *
 * Anti-eco: o que o próprio sync escreveu tem hash igual ao last_written_hash e não vira job. A listagem instável do B
 * (página repetida ou pulada) só atrasa a detecção para o próximo ciclo; nunca cria nada.
 *
 * Exclusão no B (ADR-015): um registro excluído some da listagem, então nunca seria comparado. Depois de uma listagem
 * completa, todo registro mapeado que não apareceu é suspeito e é confirmado por GET (a listagem pode ter pulado uma
 * página): 200 → foi a paginação; 410 (lápide) ou 404 (perdido) → job b_changed, e o processJob decide.
 */
export async function scanOnce(deps: BScannerDeps): Promise<ScanResult> {
  const { rows } = await deps.pool.query<{ a_ticket_id: string; b_record_id: string; last_written_hash: string | null }>(
    `SELECT a_ticket_id, b_record_id, last_written_hash FROM ticket_mapping
     WHERE state = 'active' AND b_record_id IS NOT NULL AND last_written_hash IS NOT NULL`,
  );
  const mapped = new Map(rows.map((r) => [r.b_record_id, { ticketId: Number(r.a_ticket_id), hash: r.last_written_hash }]));
  if (mapped.size === 0) return { seen: 0, changed: 0, missing: 0 };

  let seen = 0;
  const changed = new Set<number>();
  const listed = new Set<string>();
  for (let page = 1; ; page++) {
    const res = await deps.b.listRecords(page, deps.pageSize);
    for (const rec of res.items) {
      seen++;
      listed.add(rec.id);
      const m = mapped.get(rec.id);
      // Só o que o sync mapeou, e só se o marcador ainda aponta para o mesmo chamado
      if (!m || findMarker(rec[deps.markerField]) !== m.ticketId) continue;
      if (hashRecord(rec as RecordInput) !== m.hash && !changed.has(m.ticketId)) {
        changed.add(m.ticketId);
        await enqueue(deps.pool, m.ticketId, B_CHANGED_JOB_KIND);
      }
    }
    if (res.items.length === 0 || page * res.pageSize >= res.total) break;
  }
  if (changed.size > 0) deps.logger.info({ seen, changed: [...changed] }, 'varredura do B: mudanças feitas no B');

  let missing = 0;
  let checked = 0;
  for (const [recordId, m] of mapped) {
    if (listed.has(recordId) || changed.has(m.ticketId)) continue;
    // O resto fica para o próximo ciclo (a suspeita não se perde: o registro continua fora da listagem)
    if (++checked > MAX_SUSPECTS_PER_SCAN) break;
    try {
      const rec = await deps.b.getRecord(recordId);
      if (rec) {
        // Mesmo filtro da listagem: o marcador precisa apontar para o mesmo chamado
        if (findMarker(rec[deps.markerField]) !== m.ticketId) continue;
        // Estava lá: a listagem pulou a página. Se mudou, entra como qualquer mudança do B
        if (hashRecord(rec as RecordInput) !== m.hash) {
          changed.add(m.ticketId);
          await enqueue(deps.pool, m.ticketId, B_CHANGED_JOB_KIND);
        }
        continue;
      }
    } catch (err) {
      // Só o 410 confirma; erro transitório deixa a suspeita para o próximo ciclo
      if (!(err instanceof BError && err.reason === 'gone')) {
        // B fora ou pedindo calma: insistir agora só piora. Para o ciclo; o próximo retoma
        if (err instanceof BError && (err.reason === 'circuit_open' || err.reason === 'rate_limited')) {
          deps.logger.info({ reason: err.reason }, 'varredura do B: confirmação interrompida (B indisponível)');
          break;
        }
        deps.logger.debug({ err, b_record_id: recordId }, 'varredura do B: não deu para confirmar o registro sumido');
        continue;
      }
    }
    missing++;
    await enqueue(deps.pool, m.ticketId, B_CHANGED_JOB_KIND);
    deps.logger.info({ ticket_id: m.ticketId, b_record_id: recordId }, 'varredura do B: registro mapeado sumiu do B');
  }
  return { seen, changed: changed.size, missing };
}

/** Laço da varredura: um ciclo a cada `intervalMs` (o primeiro também espera um intervalo). */
export function startBScanner(deps: BScannerDeps & { intervalMs: number; isReady: () => boolean }): Loop {
  return startLoop({
    run: () => scanOnce(deps),
    intervalMs: deps.intervalMs,
    firstDelayMs: deps.intervalMs,
    isReady: deps.isReady,
    logger: deps.logger,
    failMessage: 'varredura do B falhou; tenta de novo no próximo ciclo',
  });
}
