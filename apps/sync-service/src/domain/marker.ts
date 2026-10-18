import { MappingError } from './errors.js';

const TRAILING_MARKER_PATTERN = /⟦s:glpi-(\d+)⟧\s*$/;

export function markerFor(aId: number): string {
  if (!Number.isInteger(aId) || aId < 1) {
    throw new MappingError('id', aId, 'ID do chamado no Sistema A deve ser inteiro positivo.');
  }
  return `⟦s:glpi-${aId}⟧`;
}

export function appendMarker(text: string, marker: string, separator: string = '\n\n'): string {
  if (text.length === 0) {
    return marker;
  }
  return `${text}${separator}${marker}`;
}

export function findMarker(text: string): number | null {
  const match = TRAILING_MARKER_PATTERN.exec(text);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return null;
  }
  return parsed;
}
