import { describe, expect, it } from 'vitest';
import {
  SYNCABLE_TICKET_FIELDS,
  canonicalJson,
  hashRecord,
  hashTicket,
} from '../../../src/domain/hash.js';
import { mapTicketToRecord } from '../../../src/domain/mapper.js';
import type { BRecord, GlpiTicket, RecordInput } from '../../../src/domain/types.js';

const BASE_TICKET: GlpiTicket = {
  id: 42,
  name: 'Impressora do 3º andar não imprime',
  content: '<p>A impressora da recepção parou de responder após queda de energia.</p>',
  status: 2,
  priority: 4,
  itilcategories_id: 3,
  locations_id: 1,
  users_id_recipient: 2,
  users_id_assign: 1,
  date: '2026-10-18 13:50:00',
  date_mod: '2026-10-18 14:03:22',
  solvedate: null,
  closedate: null,
  attachments: [],
};

describe('hashTicket e hashRecord (ADR-005, C6, F3)', () => {
  it('mudar só date_mod não muda o hash', () => {
    const before = hashTicket(BASE_TICKET);
    const after = hashTicket({
      ...BASE_TICKET,
      date_mod: '2026-10-18 19:59:59',
    });
    expect(after).toBe(before);
  });

  it('mudar id, date, solvedate ou closedate não muda o hash', () => {
    const base = hashTicket(BASE_TICKET);
    expect(
      hashTicket({
        ...BASE_TICKET,
        id: 999,
        date: '2020-01-01 00:00:00',
        solvedate: '2026-10-18 15:00:00',
        closedate: '2026-10-18 16:00:00',
      }),
    ).toBe(base);
  });

  it.each<[typeof SYNCABLE_TICKET_FIELDS[number], Partial<GlpiTicket>]>([
    ['name', { name: 'Outro título' }],
    ['content', { content: '<p>Outra descrição</p>' }],
    ['status', { status: 4 }],
    ['priority', { priority: 6 }],
    ['itilcategories_id', { itilcategories_id: 9 }],
    ['locations_id', { locations_id: 8 }],
    ['users_id_recipient', { users_id_recipient: 7 }],
    ['users_id_assign', { users_id_assign: 6 }],
    ['attachments', { attachments: [{ name: 'a.txt', size: 1, sha256: '0'.repeat(64) }] }],
  ])('mudar o campo sincronizável %s muda o hash', (_field, patch) => {
    const base = hashTicket(BASE_TICKET);
    const changed = hashTicket({ ...BASE_TICKET, ...patch });
    expect(changed).not.toBe(base);
  });

  it('ordem das chaves não muda o hash e undefined/null dão o mesmo hash', () => {
    expect(canonicalJson({ b: 1, a: { y: undefined, x: [2, undefined] } })).toBe(
      canonicalJson({ a: { x: [2, null], y: null }, b: 1 }),
    );

    const ticketWithUndefined: GlpiTicket = {
      id: 42,
      name: 'Chamado',
      content: 'Texto',
      status: 1,
      priority: 1,
      date: '2026-10-18 10:00:00',
      date_mod: '2026-10-18 10:00:00',
    };
    const ticketWithExplicitNulls: GlpiTicket = {
      date_mod: '2026-10-18 10:00:00',
      date: '2026-10-18 10:00:00',
      priority: 1,
      status: 1,
      content: 'Texto',
      name: 'Chamado',
      id: 42,
      itilcategories_id: null,
      locations_id: null,
      users_id_recipient: null,
      users_id_assign: null,
      attachments: [],
    };
    expect(hashTicket(ticketWithUndefined)).toBe(hashTicket(ticketWithExplicitNulls));
  });

  it('hashRecord ignora sourceUpdatedAt, id, createdAt, updatedAt e updatedBy (C6)', () => {
    const input = mapTicketToRecord(BASE_TICKET, { timeZone: 'America/Sao_Paulo' });
    const recordFromB: BRecord = {
      ...input,
      id: 'B-981',
      sourceUpdatedAt: '1999-01-01T00:00:00Z',
      createdAt: '2035-05-05T10:00:00Z',
      updatedAt: '2035-05-05T12:00:00Z',
      updatedBy: 'operador-b',
    };

    expect(hashRecord(recordFromB)).toBe(hashRecord(input));
  });

  it('hashRecord do RecordInput escrito é igual ao do Record lido de volta, com ou sem location/attachments (F3)', () => {
    const inputWithLoc: RecordInput = {
      title: 'Teste',
      description: 'Desc\n\n⟦s:glpi-1⟧',
      state: 'OPEN',
      severity: 'LOW',
      location: { name: 'Sala 1' },
      attachments: [{ name: 'f.bin', size: 10, sha256: 'f'.repeat(64) }],
    };
    const readBackWithExplicitNulls: BRecord = {
      id: 'B-1',
      title: 'Teste',
      description: 'Desc\n\n⟦s:glpi-1⟧',
      state: 'OPEN',
      severity: 'LOW',
      category: null,
      requester: null,
      assignee: null,
      location: { lng: null, lat: null, name: 'Sala 1' },
      sourceUpdatedAt: '2026-10-18T17:00:00Z',
      attachments: [{ sha256: 'f'.repeat(64), size: 10, name: 'f.bin' }],
      createdAt: '2026-10-18T17:00:01Z',
      updatedAt: '2026-10-18T17:00:01Z',
    };
    expect(hashRecord(inputWithLoc)).toBe(hashRecord(readBackWithExplicitNulls));

    const inputWithCoordsOnly: RecordInput = {
      ...inputWithLoc,
      location: { lat: -23.5, lng: -46.6 },
    };
    const inputWithNullName: RecordInput = {
      ...inputWithLoc,
      location: { name: null, lat: -23.5, lng: -46.6 },
    };
    expect(hashRecord(inputWithCoordsOnly)).toBe(hashRecord(inputWithNullName));

    const minimalInput: RecordInput = {
      title: 'Min',
      description: '⟦s:glpi-2⟧',
      state: 'CLOSED',
      severity: 'CRITICAL',
    };
    expect(hashRecord(minimalInput)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hash tem 64 hex minúsculos', () => {
    expect(hashTicket(BASE_TICKET)).toMatch(/^[0-9a-f]{64}$/);
  });
});
