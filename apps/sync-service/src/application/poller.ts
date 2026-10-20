import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { SystemAClient } from '../adapters/system-a/client.js';
import { glpiLocalToUtc, hashTicket, pollLowerBoundLocal } from '../domain/index.js';
import { enqueue } from '../infra/queue/queue.js';
import { startLoop, type Loop } from '../infra/loop.js';

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

  // Duas listas, como no GLPI: os chamados ativos e os da lixeira (exclusão e restauração também são mudança)
  for (const deleted of [false, true]) {
    for (let start = 0; ; start += deps.pageSize) {
      const page = await deps.a.listChangedSince(lowerLocal, start, deps.pageSize, deleted);
      for (const ticket of page.items) {
        seen++;
        const dateModUtc = glpiLocalToUtc(ticket.date_mod, deps.timeZone);
        maxMs = Math.max(maxMs, Date.parse(dateModUtc));
        const client = await deps.pool.connect();
        try {
          await client.query('BEGIN');
          // Nada a registrar quando: já entregue (mesmo hash); já esperando na fila (o job pendente vai reler o A); ou
          // esta versão já foi para a DLQ (morreu pelo menos 1 s depois do date_mod). Sem a última regra, a sobreposição
          // reenfileiraria a cada ciclo um chamado que o B recusa, e a DLQ encheria do mesmo chamado. Se o A mudar o
          // chamado de novo, o date_mod passa da morte e ele volta. Job rodando não conta: o enqueue marca rerun
          const fresh = await client.query(
            `SELECT 1 FROM ticket_mapping WHERE a_ticket_id = $1 AND state IN ('active', 'archived') AND last_synced_hash = $2
             UNION ALL
             SELECT 1 FROM sync_jobs WHERE ticket_id = $1 AND status = 'pending'
             UNION ALL
             SELECT 1 FROM sync_jobs WHERE ticket_id = $1 AND status = 'dead' AND reprocessed_at IS NULL
               AND updated_at >= $3::timestamptz + interval '1 second'`,
            [ticket.id, hashTicket(ticket), dateModUtc],
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

/** Laço do poller: o primeiro ciclo na hora, depois um a cada `intervalMs`. */
export function startPoller(deps: PollerDeps & { intervalMs: number; isReady: () => boolean }): Loop {
  return startLoop({
    run: () => pollOnce(deps),
    intervalMs: deps.intervalMs,
    firstDelayMs: 0,
    isReady: deps.isReady,
    logger: deps.logger,
    failMessage: 'poll do A falhou; tenta de novo no próximo ciclo',
  });
}
