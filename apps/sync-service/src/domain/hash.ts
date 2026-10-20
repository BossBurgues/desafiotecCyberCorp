import { createHash } from 'node:crypto';
import type { BRecord, GlpiTicket, RecordInput } from './types.js';

export const HASH_VERSION_PREFIX = 'v1:';

export const SYNCABLE_TICKET_FIELDS = [
  'name',
  'content',
  'status',
  'priority',
  'itilcategories_id',
  'locations_id',
  'users_id_recipient',
  'users_id_assign',
  'attachments',
] as const satisfies readonly (keyof GlpiTicket)[];

export const SYNCABLE_RECORD_FIELDS = [
  'title',
  'description',
  'state',
  'severity',
  'category',
  'requester',
  'assignee',
  'location',
  'attachments',
] as const satisfies readonly (keyof RecordInput)[];

function normalizeCanonical(value: unknown): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeCanonical(item));
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      out[key] = normalizeCanonical(obj[key]);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeCanonical(value));
}

function sha256Versioned(payload: unknown): string {
  return createHash('sha256')
    .update(`${HASH_VERSION_PREFIX}${canonicalJson(payload)}`, 'utf8')
    .digest('hex');
}

export function hashTicket(ticket: GlpiTicket): string {
  const syncableSlice: Record<string, unknown> = {
    name: ticket.name,
    content: ticket.content,
    status: ticket.status,
    priority: ticket.priority,
    itilcategories_id: ticket.itilcategories_id ?? null,
    locations_id: ticket.locations_id ?? null,
    users_id_recipient: ticket.users_id_recipient ?? null,
    users_id_assign: ticket.users_id_assign ?? null,
    attachments: (ticket.attachments ?? []).map((item) => ({
      name: item.name,
      size: item.size,
      sha256: item.sha256,
    })),
  };
  // Só entra quando excluído: o hash dos chamados fora da lixeira continua o mesmo de antes do ADR-015
  if (ticket.is_deleted === 1) {
    syncableSlice.is_deleted = 1;
  }
  return sha256Versioned(syncableSlice);
}

export function hashRecord(recordOrInput: RecordInput | BRecord): string {
  const loc = recordOrInput.location ?? null;
  const syncableSlice: Record<string, unknown> = {
    title: recordOrInput.title,
    description: recordOrInput.description,
    state: recordOrInput.state,
    severity: recordOrInput.severity,
    category: recordOrInput.category ?? null,
    requester: recordOrInput.requester ?? null,
    assignee: recordOrInput.assignee ?? null,
    location:
      loc === null
        ? null
        : {
            name: loc.name ?? null,
            lat: loc.lat ?? null,
            lng: loc.lng ?? null,
          },
    attachments: (recordOrInput.attachments ?? []).map((item) => ({
      name: item.name,
      size: item.size,
      sha256: item.sha256,
    })),
  };
  return sha256Versioned(syncableSlice);
}
