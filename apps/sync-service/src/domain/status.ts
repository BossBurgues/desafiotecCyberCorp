import { MappingError } from './errors.js';
import type { RecordSeverity, RecordState, TicketPriority, TicketStatus } from './types.js';

export const STATUS_TO_STATE = {
  1: 'OPEN',
  2: 'IN_PROGRESS',
  3: 'IN_PROGRESS',
  4: 'ON_HOLD',
  5: 'RESOLVED',
  6: 'CLOSED',
} as const satisfies Record<TicketStatus, RecordState>;

export const PRIORITY_TO_SEVERITY = {
  1: 'LOW',
  2: 'LOW',
  3: 'MEDIUM',
  4: 'HIGH',
  5: 'CRITICAL',
  6: 'CRITICAL',
} as const satisfies Record<TicketPriority, RecordSeverity>;

function isOneToSix(value: unknown): value is 1 | 2 | 3 | 4 | 5 | 6 {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6;
}

export function toState(status: unknown): RecordState {
  if (!isOneToSix(status)) {
    throw new MappingError('status', status, 'status do chamado deve ser inteiro entre 1 e 6.');
  }
  return STATUS_TO_STATE[status];
}

export function toSeverity(priority: unknown): RecordSeverity {
  if (!isOneToSix(priority)) {
    throw new MappingError('priority', priority, 'prioridade do chamado deve ser inteiro entre 1 e 6.');
  }
  return PRIORITY_TO_SEVERITY[priority];
}
