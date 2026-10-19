import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { SystemBClient } from '../adapters/system-b/client.js';
import { findMarker, hashRecord } from '../domain/index.js';
import type { MarkerField, RecordInput } from '../domain/types.js';
import { B_CHANGED_JOB_KIND, enqueue } from '../infra/queue/queue.js';

export interface BScannerDeps {
  pool: Pool;
  b: SystemBClient;
  logger: Logger;
  markerField: MarkerField;
  pageSize: number;
}

export interface ScanResult {
  seen: number;
  changed: number;
}

/**
 * B → A leve (ADR-014): o B não avisa ninguém, então o sync olha. Percorre a listagem do B e, para cada registro
 * mapeado cujo conteúdo não é mais o que o sync escreveu (hash ≠ last_written_hash), enfileira um job b_changed.
 * Quem decide o que fazer é o processJob, com o mesmo lease, retry e auditoria do A → B.
 *
 * Anti-eco: o que o próprio sync escreveu tem hash igual ao last_written_hash e não vira job. A listagem instável do B
 * (página repetida ou pulada) só atrasa a detecção para o próximo ciclo; nunca cria nada.
 */
export async function scanOnce(deps: BScannerDeps): Promise<ScanResult> {
  const { rows } = await deps.pool.query<{ a_ticket_id: string; b_record_id: string; last_written_hash: string | null }>(
    `SELECT a_ticket_id, b_record_id, last_written_hash FROM ticket_mapping
     WHERE state = 'active' AND b_record_id IS NOT NULL AND last_written_hash IS NOT NULL`,
  );
  const mapped = new Map(rows.map((r) => [r.b_record_id, { ticketId: Number(r.a_ticket_id), hash: r.last_written_hash }]));
  if (mapped.size === 0) return { seen: 0, changed: 0 };

  let seen = 0;
  const changed = new Set<number>();
  for (let page = 1; ; page++) {
    const res = await deps.b.listRecords(page, deps.pageSize);
    for (const rec of res.items) {
      seen++;
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
  return { seen, changed: changed.size };
}

/** Laço da varredura: um ciclo a cada `intervalMs`, só com as dependências de pé; erro num ciclo espera o próximo. */
export function startBScanner(deps: BScannerDeps & { intervalMs: number; isReady: () => boolean }): { stop(): Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  const loop = () => {
    running = (async () => {
      if (!deps.isReady()) return;
      try {
        await scanOnce(deps);
      } catch (err) {
        deps.logger.warn({ err }, 'varredura do B falhou; tenta de novo no próximo ciclo');
      }
    })().finally(() => {
      if (!stopped) timer = setTimeout(loop, deps.intervalMs);
    });
  };
  timer = setTimeout(loop, deps.intervalMs);
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
