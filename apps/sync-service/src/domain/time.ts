import { MappingError } from './errors.js';

const GLPI_DATETIME_REGEX = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || timeZone.trim().length === 0) {
    return false;
  }
  try {
    getFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

function parseInstantMs(instant: Date | string | number, fieldName: string): number {
  const ms = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  if (Number.isNaN(ms)) {
    throw new MappingError(fieldName, instant, 'instante UTC inválido.');
  }
  return ms;
}

function formatUtcNoMs(epochMs: number): string {
  const iso = new Date(Math.trunc(epochMs / 1000) * 1000).toISOString();
  return `${iso.slice(0, 19)}Z`;
}

function formatMsInZone(epochMs: number, formatter: Intl.DateTimeFormat): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  formatted: string;
} {
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(epochMs))) {
    parts[part.type] = part.value;
  }
  const year = parts['year']!;
  const month = parts['month']!;
  const day = parts['day']!;
  const hour = parts['hour']!;
  const minute = parts['minute']!;
  const second = parts['second']!;

  return {
    year: Number.parseInt(year, 10),
    month: Number.parseInt(month, 10),
    day: Number.parseInt(day, 10),
    hour: Number.parseInt(hour, 10),
    minute: Number.parseInt(minute, 10),
    second: Number.parseInt(second, 10),
    formatted: `${year}-${month}-${day} ${hour}:${minute}:${second}`,
  };
}

function getTimeZoneOffsetMs(epochMs: number, formatter: Intl.DateTimeFormat): number {
  const local = formatMsInZone(epochMs, formatter);
  const localWallMs = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  const truncatedEpochMs = Math.trunc(epochMs / 1000) * 1000;
  return localWallMs - truncatedEpochMs;
}

export function utcToGlpiLocal(instant: Date | string | number, timeZone: string): string {
  const formatter = getFormatter(timeZone);
  const ms = parseInstantMs(instant, 'instant');
  return formatMsInZone(ms, formatter).formatted;
}

export function glpiLocalToUtc(glpiDateTime: string, timeZone: string): string {
  const formatter = getFormatter(timeZone);
  const match = GLPI_DATETIME_REGEX.exec(glpiDateTime);
  if (!match) {
    throw new MappingError(
      'date_mod',
      glpiDateTime,
      'esperado formato GlpiDateTime YYYY-MM-DD HH:MM:SS.',
    );
  }

  const year = Number.parseInt(match[1]!, 10);
  const month = Number.parseInt(match[2]!, 10);
  const day = Number.parseInt(match[3]!, 10);
  const hour = Number.parseInt(match[4]!, 10);
  const minute = Number.parseInt(match[5]!, 10);
  const second = Number.parseInt(match[6]!, 10);

  if (hour > 23 || minute > 59 || second > 59) {
    throw new MappingError('date_mod', glpiDateTime, 'hora fora da faixa válida.');
  }

  const wallUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const checkDate = new Date(wallUtcMs);
  if (
    checkDate.getUTCFullYear() !== year ||
    checkDate.getUTCMonth() + 1 !== month ||
    checkDate.getUTCDate() !== day
  ) {
    throw new MappingError('date_mod', glpiDateTime, 'data de calendário inexistente.');
  }

  // Política compatible (Temporal):
  // - Em hora repetida (volta do DST, offsetEarlier > offsetLater), usa offsetEarlier (1ª ocorrência).
  // - Em hora inexistente (ida do DST, offsetEarlier < offsetLater), usa offsetEarlier (avança o buraco).
  const offsetAtNominal = getTimeZoneOffsetMs(wallUtcMs, formatter);
  const nominalUtcMs = wallUtcMs - offsetAtNominal;
  const offsetEarlier = getTimeZoneOffsetMs(nominalUtcMs - SIX_HOURS_MS, formatter);
  const candidateFirstMs = wallUtcMs - offsetEarlier;

  if (formatMsInZone(candidateFirstMs, formatter).formatted === glpiDateTime) {
    return formatUtcNoMs(candidateFirstMs);
  }

  const offsetLater = getTimeZoneOffsetMs(nominalUtcMs + SIX_HOURS_MS, formatter);
  const candidateSecondMs = wallUtcMs - offsetLater;

  if (formatMsInZone(candidateSecondMs, formatter).formatted === glpiDateTime) {
    return formatUtcNoMs(candidateSecondMs);
  }

  // Hora inexistente na ida do horário de verão: avança pelo offset anterior à transição
  return formatUtcNoMs(candidateFirstMs);
}

export function pollLowerBoundLocal(
  fromUtc: Date | string | number,
  toUtc: Date | string | number,
  timeZone: string,
): string {
  const formatter = getFormatter(timeZone);
  const fromMs = parseInstantMs(fromUtc, 'fromUtc');
  const toMs = parseInstantMs(toUtc, 'toUtc');
  if (toMs < fromMs) {
    throw new MappingError('toUtc', toUtc, 'toUtc não pode ser anterior a fromUtc.');
  }

  let minOffsetMs = Math.min(
    getTimeZoneOffsetMs(fromMs, formatter),
    getTimeZoneOffsetMs(toMs, formatter),
  );

  for (let sampleMs = fromMs + TWENTY_FOUR_HOURS_MS; sampleMs < toMs; sampleMs += TWENTY_FOUR_HOURS_MS) {
    minOffsetMs = Math.min(minOffsetMs, getTimeZoneOffsetMs(sampleMs, formatter));
  }

  const truncatedFromMs = Math.trunc(fromMs / 1000) * 1000;
  const wallMsAtMinOffset = truncatedFromMs + minOffsetMs;
  const iso = new Date(wallMsAtMinOffset).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}
