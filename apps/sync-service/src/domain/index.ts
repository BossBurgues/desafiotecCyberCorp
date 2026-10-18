export { MappingError } from './errors.js';
export {
  HASH_VERSION_PREFIX,
  SYNCABLE_RECORD_FIELDS,
  SYNCABLE_TICKET_FIELDS,
  canonicalJson,
  hashRecord,
  hashTicket,
} from './hash.js';
export { htmlToText } from './html-to-text.js';
export { mapTicketToRecord } from './mapper.js';
export { appendMarker, findMarker, markerFor } from './marker.js';
export { PRIORITY_TO_SEVERITY, STATUS_TO_STATE, toSeverity, toState } from './status.js';
export {
  MAX_TITLE_CODE_POINTS,
  neutralizeMarkers,
  normalizeTitle,
  truncateByGraphemeCodePoints,
} from './text.js';
export {
  glpiLocalToUtc,
  isValidTimeZone,
  pollLowerBoundLocal,
  utcToGlpiLocal,
} from './time.js';
export type {
  BRecord,
  GlpiDateTime,
  GlpiTicket,
  Lookups,
  MapTicketOptions,
  MarkerField,
  RecordAttachment,
  RecordInput,
  RecordLocation,
  RecordSeverity,
  RecordState,
  TicketAttachment,
  TicketPriority,
  TicketStatus,
} from './types.js';
