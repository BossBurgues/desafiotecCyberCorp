import { describe, expect, it } from 'vitest';
import { findMarker } from '../../../src/domain/marker.js';
import { mapTicketToRecord } from '../../../src/domain/mapper.js';
import type { GlpiTicket, Lookups } from '../../../src/domain/types.js';

const CONTRACT_TICKET_EXAMPLE: GlpiTicket = {
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
};

const CONTRACT_LOOKUPS: Lookups = {
  categories: {
    3: 'Hardware > Impressoras',
  },
  users: new Map([
    [1, 'tecnico@cybercorp.local'],
    [2, 'maria@cybercorp.local'],
  ]),
  locations: {
    1: {
      name: 'Matriz - 3º andar',
      lat: -23.5505,
      lng: -46.6333,
    },
  },
};

describe('mapTicketToRecord (seção 9)', () => {
  it('exemplo do contrato do A vira o exemplo do contrato do B', () => {
    const recordInput = mapTicketToRecord(CONTRACT_TICKET_EXAMPLE, {
      timeZone: 'America/Sao_Paulo',
      lookups: CONTRACT_LOOKUPS,
    });

    expect(recordInput).toEqual({
      title: 'Impressora do 3º andar não imprime',
      description:
        'A impressora da recepção parou de responder após queda de energia.\n\n⟦s:glpi-42⟧',
      state: 'IN_PROGRESS',
      severity: 'HIGH',
      category: 'Hardware > Impressoras',
      requester: 'maria@cybercorp.local',
      assignee: 'tecnico@cybercorp.local',
      location: {
        name: 'Matriz - 3º andar',
        lat: -23.5505,
        lng: -46.6333,
      },
      sourceUpdatedAt: '2026-10-18T17:03:22Z',
      attachments: [],
    });
  });

  it('descrição termina com \\n\\n⟦s:glpi-<id>⟧ e neutraliza marcadores forjados no HTML', () => {
    const ticket: GlpiTicket = {
      ...CONTRACT_TICKET_EXAMPLE,
      id: 108,
      content: '<p>Tentativa de forjar ⟦s:glpi-999⟧ no meio</p>',
    };

    const record = mapTicketToRecord(ticket, { timeZone: 'America/Sao_Paulo' });
    expect(record.description).toBe('Tentativa de forjar [s:glpi-999] no meio\n\n⟦s:glpi-108⟧');
    expect(findMarker(record.description)).toBe(108);
  });

  it('com B_MARKER_FIELD=title o marcador vai no título e o título continua com até 200 code points', () => {
    const ticket: GlpiTicket = {
      ...CONTRACT_TICKET_EXAMPLE,
      id: 42,
      name: 'x'.repeat(250),
    };

    const record = mapTicketToRecord(ticket, {
      timeZone: 'America/Sao_Paulo',
      markerField: 'title',
    });

    expect(record.title.endsWith(' ⟦s:glpi-42⟧')).toBe(true);
    expect([...record.title].length).toBe(200);
    expect(findMarker(record.title)).toBe(42);
    expect(record.description).toBe(
      'A impressora da recepção parou de responder após queda de energia.',
    );
  });

  it('categoria, requerente, técnico e localização sem entrada na tabela viram null (e coordenadas ausentes viram null)', () => {
    const withoutLookups = mapTicketToRecord(
      {
        ...CONTRACT_TICKET_EXAMPLE,
        itilcategories_id: 999,
        locations_id: 999,
        users_id_recipient: null,
        users_id_assign: 999,
      },
      {
        timeZone: 'America/Sao_Paulo',
        lookups: {
          categories: new Map([[3, 'Outra']]),
          users: { 1: 'tecnico@cybercorp.local' },
          locations: new Map([[1, {}]]),
        },
      },
    );

    expect(withoutLookups.category).toBeNull();
    expect(withoutLookups.requester).toBeNull();
    expect(withoutLookups.assignee).toBeNull();
    expect(withoutLookups.location).toBeNull();

    const partialLocation = mapTicketToRecord(CONTRACT_TICKET_EXAMPLE, {
      timeZone: 'America/Sao_Paulo',
      lookups: {
        locations: new Map([[1, {}]]),
      },
    });
    expect(partialLocation.location).toEqual({ name: null, lat: null, lng: null });
  });

  it('anexos são copiados só com name, size e sha256', () => {
    const sha = 'a'.repeat(64);
    const rawAttachment = { name: 'relatorio.pdf', size: 2048, sha256: sha, extra: 'ignorar' };
    const ticketWithExtraAttachmentField: GlpiTicket = {
      ...CONTRACT_TICKET_EXAMPLE,
      attachments: [rawAttachment],
    };

    const record = mapTicketToRecord(ticketWithExtraAttachmentField, {
      timeZone: 'America/Sao_Paulo',
    });

    expect(record.attachments).toEqual([{ name: 'relatorio.pdf', size: 2048, sha256: sha }]);
  });

  it('sourceUpdatedAt é o date_mod em UTC', () => {
    const record = mapTicketToRecord(
      { ...CONTRACT_TICKET_EXAMPLE, date_mod: '2026-10-18 20:00:00' },
      { timeZone: 'America/Sao_Paulo' },
    );
    expect(record.sourceUpdatedAt).toBe('2026-10-18T23:00:00Z');
  });

  it('o mapper não altera o chamado recebido', () => {
    const ticket: GlpiTicket = {
      ...CONTRACT_TICKET_EXAMPLE,
      attachments: [{ name: 'log.txt', size: 12, sha256: 'b'.repeat(64) }],
    };
    const snapshot = structuredClone(ticket);

    mapTicketToRecord(ticket, {
      timeZone: 'America/Sao_Paulo',
      lookups: CONTRACT_LOOKUPS,
    });

    expect(ticket).toEqual(snapshot);
  });
});
