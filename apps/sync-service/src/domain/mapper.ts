import { htmlToText } from './html-to-text.js';
import { appendMarker, markerFor } from './marker.js';
import { toSeverity, toState } from './status.js';
import { MAX_TITLE_CODE_POINTS, neutralizeMarkers, normalizeTitle } from './text.js';
import { glpiLocalToUtc } from './time.js';
import type {
  GlpiTicket,
  MapTicketOptions,
  RecordAttachment,
  RecordInput,
  RecordLocation,
} from './types.js';

function lookupValue<T>(
  table: ReadonlyMap<number, T> | Readonly<Record<number, T>> | undefined,
  id: number | null | undefined,
): T | null {
  if (id === null || id === undefined || table === undefined) {
    return null;
  }
  if (table instanceof Map) {
    return table.get(id) ?? null;
  }
  const found = (table as Readonly<Record<number, T>>)[id];
  return found ?? null;
}

function cloneLocation(loc: RecordLocation | null): RecordLocation | null {
  if (loc === null) {
    return null;
  }
  return {
    name: loc.name ?? null,
    lat: loc.lat ?? null,
    lng: loc.lng ?? null,
  };
}

function cloneAttachments(attachments: GlpiTicket['attachments']): RecordAttachment[] {
  if (!attachments || attachments.length === 0) {
    return [];
  }
  return attachments.map((item) => ({
    name: item.name,
    size: item.size,
    sha256: item.sha256,
  }));
}

export function mapTicketToRecord(ticket: GlpiTicket, options: MapTicketOptions): RecordInput {
  const markerField = options.markerField ?? 'description';
  const marker = markerFor(ticket.id);
  const cleanDescription = neutralizeMarkers(htmlToText(ticket.content));

  let title: string;
  let description: string;

  if (markerField === 'title') {
    const reservedForMarker = [...marker].length + 1;
    const baseTitle = normalizeTitle(ticket.name, MAX_TITLE_CODE_POINTS - reservedForMarker);
    title = appendMarker(baseTitle, marker, ' ');
    description = cleanDescription;
  } else {
    title = normalizeTitle(ticket.name, MAX_TITLE_CODE_POINTS);
    description = appendMarker(cleanDescription, marker, '\n\n');
  }

  const lookups = options.lookups;
  const category = lookupValue(lookups?.categories, ticket.itilcategories_id);
  const requester = lookupValue(lookups?.users, ticket.users_id_recipient);
  const assignee = lookupValue(lookups?.users, ticket.users_id_assign);
  const location = cloneLocation(lookupValue(lookups?.locations, ticket.locations_id));

  return {
    title,
    description,
    state: toState(ticket.status),
    severity: toSeverity(ticket.priority),
    category,
    requester,
    assignee,
    location,
    sourceUpdatedAt: glpiLocalToUtc(ticket.date_mod, options.timeZone),
    attachments: cloneAttachments(ticket.attachments),
  };
}
