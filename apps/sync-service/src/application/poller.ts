import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { SystemAClient } from '../adapters/system-a/client.js';
import { glpiLocalToUtc, hashTicket, pollLowerBoundLocal } from '../domain/index.js';
import { enqueue } from '../infra/queue/queue.js';

export const POLL_SOURCE = 'system-a';

export interface PollerDeps {
  pool: Pool;
  a: SystemAClient;
  logger: Logger;
  timeZone: string;
  overlapMs: number;
  pageSize: number;
  now?: () => number;
}

export interface PollResult {
  seen: number;
  enqueued: number;
  checkpoint: string;
}

/**
 * Um ciclo do poller do A (S3.4): a rede de segurança do webhook. Pede ao A tudo com date_mod >= checkpoint − 2 min
 * (a sobreposição cobre relógio, transação que commitou atrasada e dois updates no mesmo segundo) e enfileira.
 * O checkpoint só avança depois de enfileirar: se o sync cair no meio, o próximo ciclo relê a mesma janela.
 *
 * A listagem já traz o chamado inteiro: se o hash dos campos sincronizáveis é o último sincronizado, não há o que
 * entregar e nada é enfileirado (a sobreposição relê os mesmos chamados a cada ciclo). Comparar pelo hash, e não pelo
 * date_mod, cobre dois updates no mesmo segundo (B12): o date_mod é igual, o hash não.
 */
export async function pollOnce(deps: PollerDeps): Promise<PollResult> {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const { rows } = await deps.pool.query<{ last_date_mod_utc: Date }>(
    `SELECT last_date_mod_utc FROM poll_checkpoint WHERE source = $1`,
    [POLL_SOURCE],
  );
  // Primeira execução: tudo desde o começo (o A do desafio é pequeno; num GLPI real seria uma carga inicial à parte)
  const checkpointMs = rows[0]?.last_date_mod_utc.getTime() ?? 0;
  const fromMs = Math.max(0, checkpointMs - deps.overlapMs);
  const lowerLocal = pollLowerBoundLocal(fromMs, Math.max(fromMs, nowMs), deps.timeZone);

  let seen = 0;
  let enqueued = 0;
  let maxMs = checkpointMs;

  for (let start = 0; ; start += deps.pageSize) {
    const page = await deps.a.listChangedSince(lowerLocal, start, deps.pageSize);
    for (const ticket of page.items) {
      seen++;
      const dateModUtc = glpiLocalToUtc(ticket.date_mod, deps.timeZone);
      maxMs = Math.max(maxMs, Date.parse(dateModUtc));
      const client = await deps.pool.connect();
      try {
        await client.query('BEGIN');
        // Já entregue (mesmo hash) ou já esperando na fila (o job pendente vai reler o A): nada a registrar.
        // Job rodando não conta: o worker pode ter lido o A antes desta versão, e o enqueue marca rerun
        const fresh = await client.query(
          `SELECT 1 FROM ticket_mapping WHERE a_ticket_id = $1 AND state = 'active' AND last_synced_hash = $2
           UNION ALL
           SELECT 1 FROM sync_jobs WHERE ticket_id = $1 AND status = 'pending'`,
          [ticket.id, hashTicket(ticket)],
        );
        if (fresh.rowCount === 0) {
          await client.query(`INSERT INTO inbound_events (source, ticket_id, payload) VALUES ('poll', $1, $2)`, [
            ticket.id,
            { date_mod: ticket.date_mod },
          ]);
          await enqueue(client, ticket.id);
          enqueued++;
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }
    if (page.items.length < deps.pageSize || start + page.items.length >= page.total) break;
  }

  // Nunca além de agora: um date_mod no futuro (relógio do A adiantado) não pode pular a janela dos próximos ciclos
  const nextMs = Math.min(maxMs, nowMs);
  const checkpoint = new Date(nextMs).toISOString();
  if (nextMs > checkpointMs || rows.length === 0) {
    await deps.pool.query(
      `INSERT INTO poll_checkpoint (source, last_date_mod_utc) VALUES ($1, $2)
       ON CONFLICT (source) DO UPDATE SET last_date_mod_utc = GREATEST(poll_checkpoint.last_date_mod_utc, EXCLUDED.last_date_mod_utc), updated_at = now()`,
      [POLL_SOURCE, checkpoint],
    );
  }
  deps.logger.debug({ seen, enqueued, checkpoint }, 'poll do A');
  return { seen, enqueued, checkpoint };
}

/** Laço do poller: um ciclo a cada `intervalMs`; erro num ciclo é logado e o próximo tenta de novo. */
export function startPoller(deps: PollerDeps & { intervalMs: number; isReady: () => boolean }): { stop(): Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  const loop = () => {
    running = (async () => {
      if (!deps.isReady()) return;
      try {
        await pollOnce(deps);
      } catch (err) {
        deps.logger.warn({ err }, 'poll do A falhou; tenta de novo no próximo ciclo');
      }
    })().finally(() => {
      if (!stopped) timer = setTimeout(loop, deps.intervalMs);
    });
  };
  timer = setTimeout(loop, 0);
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
