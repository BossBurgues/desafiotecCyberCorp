import type { Pool, PoolClient } from 'pg';

type Db = Pick<Pool | PoolClient, 'query'>;

export interface AuditEntry {
  ticketId: number | null;
  direction: 'a_to_b' | 'b_to_a' | 'inbound' | null;
  action: string;
  actor: string;
  correlationId?: string | null;
  request?: Record<string, unknown> | null;
  response?: Record<string, unknown> | null;
  latencyMs?: number | null;
  outcome: string;
}

/**
 * Grava uma linha na trilha técnica. Só resumos (IDs, hashes, status), nunca o texto do chamado nem tokens.
 * A proteção append-only, o mascaramento e a retenção entram na S5.1 (#44).
 */
export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (ticket_id, direction, action, actor, correlation_id, request_summary, response_summary, latency_ms, outcome)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      entry.ticketId,
      entry.direction,
      entry.action,
      entry.actor,
      entry.correlationId ?? null,
      entry.request ?? null,
      entry.response ?? null,
      entry.latencyMs ?? null,
      entry.outcome,
    ],
  );
}
