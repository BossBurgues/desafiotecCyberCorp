import type { SystemAClient, TicketPage } from '../src/adapters/system-a/client.js';
import type { BRecordPage, BRecordResponse, SystemBClient } from '../src/adapters/system-b/client.js';
import { BError, type BErrorReason } from '../src/adapters/system-b/errors.js';
import type { GlpiTicket, RecordInput } from '../src/domain/types.js';

/** A em memória: chamados por ID, date_mod no fuso do A (o teste escolhe os valores). */
export function fakeA(initial: GlpiTicket[] = []) {
  const tickets = new Map<number, GlpiTicket>(initial.map((t) => [t.id, t]));
  let reads = 0;
  const client: SystemAClient = {
    async getTicket(id) {
      reads++;
      const t = tickets.get(id);
      return t ? structuredClone(t) : null;
    },
    async listChangedSince(gte, start, limit): Promise<TicketPage> {
      const all = [...tickets.values()].filter((t) => t.date_mod >= gte).sort((x, y) => x.date_mod.localeCompare(y.date_mod) || x.id - y.id);
      return { items: all.slice(start, start + limit).map((t) => structuredClone(t)), total: all.length };
    },
  };
  return {
    client,
    tickets,
    put(t: GlpiTicket) {
      tickets.set(t.id, t);
    },
    get reads() {
      return reads;
    },
  };
}

/**
 * Falha programada do B falso para a próxima chamada de um método.
 * `persist`: o B grava mesmo assim (commit-then-fail, timeout com gravação tardia, 200 com corpo de erro).
 */
export interface PlannedFailure {
  reason: BErrorReason;
  persist?: boolean;
  status?: number;
}

/** B em memória com o mesmo contrato do adapter real (BError com ambiguous em escrita). */
export function fakeB() {
  const records = new Map<string, BRecordResponse>();
  const plan: Record<'create' | 'update' | 'list', PlannedFailure[]> = { create: [], update: [], list: [] };
  const calls = { create: 0, update: 0, list: 0, get: 0 };
  let seq = 0;
  /** Ack sem gravar (cenário B5): as próximas N escritas respondem sucesso e não gravam nada. */
  const ackWithoutPersist = { create: 0, update: 0 };
  /** Listagem atrasada (cenário A7): registros criados não aparecem nas próximas N listagens. */
  let hiddenFromList = new Map<string, number>();

  const store = (input: RecordInput, id = `B-${++seq}`): BRecordResponse => {
    if (!input.title || input.title.trim() === '') {
      throw new BError('rejected', 'POST /api/v2/records: 422 validation_error: title é obrigatório', { write: true, status: 422 });
    }
    const now = new Date().toISOString();
    const rec = { ...structuredClone(input), id, createdAt: records.get(id)?.createdAt ?? now, updatedAt: now } as BRecordResponse;
    records.set(id, rec);
    return structuredClone(rec);
  };

  const failIfPlanned = (op: 'create' | 'update' | 'list', apply: () => void) => {
    const f = plan[op].shift();
    if (!f) return;
    if (f.persist) apply();
    throw new BError(f.reason, `${op}: falha programada (${f.reason})`, { write: op !== 'list', ...(f.status ? { status: f.status } : {}) });
  };

  const client: SystemBClient = {
    async createRecord(input) {
      calls.create++;
      failIfPlanned('create', () => store(input));
      if (ackWithoutPersist.create > 0) {
        ackWithoutPersist.create--;
        const now = new Date().toISOString();
        return { ...structuredClone(input), id: `B-${++seq}`, createdAt: now, updatedAt: now } as BRecordResponse;
      }
      return store(input);
    },
    async getRecord(id) {
      calls.get++;
      const r = records.get(id);
      return r ? structuredClone(r) : null;
    },
    async updateRecord(id, input) {
      calls.update++;
      failIfPlanned('update', () => store(input, id));
      if (!records.has(id)) throw new BError('not_found', `PUT /records/${id}: 404`, { write: true, status: 404 });
      if (ackWithoutPersist.update > 0) {
        ackWithoutPersist.update--;
        return { ...structuredClone(records.get(id)!), ...structuredClone(input), id, updatedAt: new Date().toISOString() };
      }
      return store(input, id);
    },
    async listRecords(page, pageSize): Promise<BRecordPage> {
      calls.list++;
      failIfPlanned('list', () => undefined);
      const visible = [...records.values()].filter((r) => {
        const left = hiddenFromList.get(r.id) ?? 0;
        if (left > 0) {
          hiddenFromList.set(r.id, left - 1);
          return false;
        }
        return true;
      });
      return { items: visible.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: visible.length };
    },
    breakerState: () => 'closed',
  };

  return {
    client,
    records,
    calls,
    plan,
    ackWithoutPersist,
    /** Esconde da listagem os registros que existirem agora pelas próximas `times` listagens. */
    hideFromList(times: number) {
      hiddenFromList = new Map([...records.keys()].map((id) => [id, times]));
    },
  };
}

export function ticket(id: number, overrides: Partial<GlpiTicket> = {}): GlpiTicket {
  return {
    id,
    name: `Chamado ${id}`,
    content: `<p>Descrição do chamado ${id}</p>`,
    status: 2,
    priority: 3,
    itilcategories_id: null,
    locations_id: null,
    users_id_recipient: null,
    users_id_assign: null,
    date: '2026-10-18 10:00:00',
    date_mod: '2026-10-18 10:00:00',
    ...overrides,
  };
}
