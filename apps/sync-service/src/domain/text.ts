import { MappingError } from './errors.js';

export const MAX_TITLE_CODE_POINTS = 200;

const graphemeSegmenter = new Intl.Segmenter('pt-BR', { granularity: 'grapheme' });

export function neutralizeMarkers(text: string): string {
  return text.replace(/⟦/g, '[').replace(/⟧/g, ']');
}

function countCodePoints(text: string): number {
  let count = 0;
  for (const _ of text) {
    count += 1;
  }
  return count;
}

export function truncateByGraphemeCodePoints(text: string, maxCodePoints: number): string {
  let result = '';
  let usedCodePoints = 0;

  for (const { segment } of graphemeSegmenter.segment(text)) {
    const segmentCodePoints = countCodePoints(segment);
    if (usedCodePoints + segmentCodePoints > maxCodePoints) {
      break;
    }
    result += segment;
    usedCodePoints += segmentCodePoints;
  }

  return result;
}

export function normalizeTitle(
  rawName: string,
  maxCodePoints: number = MAX_TITLE_CODE_POINTS,
): string {
  const safe = neutralizeMarkers(rawName);
  const collapsed = safe.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) {
    throw new MappingError('name', rawName, 'título do chamado não pode ser vazio.');
  }
  const truncated = truncateByGraphemeCodePoints(collapsed, maxCodePoints).trim();
  if (truncated.length === 0) {
    throw new MappingError('name', rawName, 'título do chamado não cabe no limite de tamanho.');
  }
  return truncated;
}
