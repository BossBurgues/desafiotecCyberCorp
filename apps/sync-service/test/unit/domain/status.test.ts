import { describe, expect, it } from 'vitest';
import { MappingError } from '../../../src/domain/errors.js';
import {
  PRIORITY_TO_SEVERITY,
  STATUS_TO_STATE,
  toSeverity,
  toState,
} from '../../../src/domain/status.js';
import type { RecordSeverity, RecordState, TicketPriority, TicketStatus } from '../../../src/domain/types.js';

describe('status e prioridade (G1)', () => {
  it.each<[TicketStatus, RecordState]>([
    [1, 'OPEN'],
    [2, 'IN_PROGRESS'],
    [3, 'IN_PROGRESS'],
    [4, 'ON_HOLD'],
    [5, 'RESOLVED'],
    [6, 'CLOSED'],
  ])('converte status %i para state %s', (status, expectedState) => {
    expect(toState(status)).toBe(expectedState);
    expect(STATUS_TO_STATE[status]).toBe(expectedState);
  });

  it.each<[TicketPriority, RecordSeverity]>([
    [1, 'LOW'],
    [2, 'LOW'],
    [3, 'MEDIUM'],
    [4, 'HIGH'],
    [5, 'CRITICAL'],
    [6, 'CRITICAL'],
  ])('converte priority %i para severity %s', (priority, expectedSeverity) => {
    expect(toSeverity(priority)).toBe(expectedSeverity);
    expect(PRIORITY_TO_SEVERITY[priority]).toBe(expectedSeverity);
  });

  it.each([0, 7, -1, 2.5, Number.NaN, null, undefined, '2'])(
    'status inválido (%p) lança MappingError permanente',
    (invalidStatus) => {
      expect(() => toState(invalidStatus)).toThrow(MappingError);
      try {
        toState(invalidStatus);
      } catch (err) {
        const mappingErr = err as MappingError;
        expect(mappingErr.permanent).toBe(true);
        expect(mappingErr.field).toBe('status');
        expect(mappingErr.value).toBe(invalidStatus);
      }
    },
  );

  it.each([0, 7, -1, 2.5, Number.NaN, null, undefined, '4'])(
    'priority inválida (%p) lança MappingError permanente',
    (invalidPriority) => {
      expect(() => toSeverity(invalidPriority)).toThrow(MappingError);
      try {
        toSeverity(invalidPriority);
      } catch (err) {
        const mappingErr = err as MappingError;
        expect(mappingErr.permanent).toBe(true);
        expect(mappingErr.field).toBe('priority');
        expect(mappingErr.value).toBe(invalidPriority);
      }
    },
  );
});
