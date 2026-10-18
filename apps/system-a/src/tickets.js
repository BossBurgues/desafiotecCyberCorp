const GLPI_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const ALLOWED_INPUT_FIELDS = new Set([
  'name',
  'content',
  'status',
  'priority',
  'itilcategories_id',
  'locations_id',
  'users_id_recipient',
  'users_id_assign',
  'solvedate',
  'closedate',
  'attachments',
]);

const NULLABLE_ID_FIELDS = [
  'itilcategories_id',
  'locations_id',
  'users_id_recipient',
  'users_id_assign',
];

const NULLABLE_DATE_FIELDS = ['solvedate', 'closedate'];

export const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

export class TicketValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TicketValidationError';
    this.glpiCode = 'ERROR_INVALID_INPUT';
    this.statusCode = 400;
  }
}

export class TicketNotFoundError extends Error {
  constructor(message = 'Chamado não encontrado.') {
    super(message);
    this.name = 'TicketNotFoundError';
    this.glpiCode = 'ERROR_ITEM_NOT_FOUND';
    this.statusCode = 404;
  }
}

export function glpiError(code, message) {
  return [String(code), String(message)];
}

export function isGlpiDateTime(value) {
  return typeof value === 'string' && GLPI_DATETIME_PATTERN.test(value);
}

// O GLPI grava datas sem offset no fuso do servidor (ADR-005); formatToParts com h23 evita meia-noite "24:00:00".
export function formatLocalDateTime(instant, timeZone = DEFAULT_TIMEZONE) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) {
    throw new TicketValidationError('Instante de data inválido.');
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
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function touch(ticket, now = Date.now, timeZone = DEFAULT_TIMEZONE) {
  const instant = typeof now === 'function' ? now() : now;
  ticket.date_mod = formatLocalDateTime(instant, timeZone);
  return ticket;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneToSix(value) {
  return Number.isInteger(value) && value >= 1 && value <= 6;
}

function isPositiveIdOrNull(value) {
  return value === null || (Number.isInteger(value) && value >= 1);
}

function validateAttachment(item, index) {
  if (!isPlainObject(item)) {
    throw new TicketValidationError(`attachments[${index}] deve ser um objeto.`);
  }
  for (const key of Object.keys(item)) {
    if (key !== 'name' && key !== 'size' && key !== 'sha256') {
      throw new TicketValidationError(`Campo desconhecido em attachments[${index}]: ${key}.`);
    }
  }
  if (typeof item.name !== 'string') {
    throw new TicketValidationError(`attachments[${index}].name deve ser texto.`);
  }
  if (!Number.isInteger(item.size) || item.size < 0) {
    throw new TicketValidationError(`attachments[${index}].size deve ser inteiro >= 0.`);
  }
  if (typeof item.sha256 !== 'string' || !SHA256_PATTERN.test(item.sha256)) {
    throw new TicketValidationError(`attachments[${index}].sha256 deve ser hash SHA-256 em hex.`);
  }
  return { name: item.name, size: item.size, sha256: item.sha256 };
}

export function validateTicketInput(input, { partial = false } = {}) {
  if (!isPlainObject(input)) {
    throw new TicketValidationError('O campo input deve ser um objeto.');
  }

  for (const key of Object.keys(input)) {
    if (!ALLOWED_INPUT_FIELDS.has(key)) {
      throw new TicketValidationError(`Campo não permitido no input: ${key}.`);
    }
  }

  const normalized = {};

  if (!partial || Object.hasOwn(input, 'name')) {
    if (typeof input.name !== 'string' || input.name.length < 1 || input.name.length > 255) {
      throw new TicketValidationError('O campo name é obrigatório e deve ter entre 1 e 255 caracteres.');
    }
    normalized.name = input.name;
  }

  if (!partial || Object.hasOwn(input, 'content')) {
    if (typeof input.content !== 'string') {
      throw new TicketValidationError('O campo content é obrigatório e deve ser texto.');
    }
    normalized.content = input.content;
  }

  if (Object.hasOwn(input, 'status')) {
    if (!isOneToSix(input.status)) {
      throw new TicketValidationError('O campo status deve ser um inteiro entre 1 e 6.');
    }
    normalized.status = input.status;
  } else if (!partial) {
    normalized.status = 1;
  }

  if (Object.hasOwn(input, 'priority')) {
    if (!isOneToSix(input.priority)) {
      throw new TicketValidationError('O campo priority deve ser um inteiro entre 1 e 6.');
    }
    normalized.priority = input.priority;
  } else if (!partial) {
    normalized.priority = 3;
  }

  for (const field of NULLABLE_ID_FIELDS) {
    if (Object.hasOwn(input, field)) {
      if (!isPositiveIdOrNull(input[field])) {
        throw new TicketValidationError(`O campo ${field} deve ser um inteiro >= 1 ou null.`);
      }
      normalized[field] = input[field];
    } else if (!partial) {
      normalized[field] = null;
    }
  }

  for (const field of NULLABLE_DATE_FIELDS) {
    if (Object.hasOwn(input, field)) {
      if (input[field] !== null && !isGlpiDateTime(input[field])) {
        throw new TicketValidationError(
          `O campo ${field} deve estar no formato YYYY-MM-DD HH:MM:SS ou ser null.`,
        );
      }
      normalized[field] = input[field];
    } else if (!partial) {
      normalized[field] = null;
    }
  }

  if (Object.hasOwn(input, 'attachments')) {
    if (!Array.isArray(input.attachments)) {
      throw new TicketValidationError('O campo attachments deve ser uma lista.');
    }
    normalized.attachments = input.attachments.map((item, idx) => validateAttachment(item, idx));
  }

  return normalized;
}

export function extractInputEnvelope(body) {
  if (!isPlainObject(body) || !Object.hasOwn(body, 'input')) {
    throw new TicketValidationError('O corpo da requisição deve ser um objeto contendo "input".');
  }
  for (const key of Object.keys(body)) {
    if (key !== 'input') {
      throw new TicketValidationError(`Campo não permitido fora de input: ${key}.`);
    }
  }
  return body.input;
}

export function prepareNewTicket(body, { now = Date.now, timeZone = DEFAULT_TIMEZONE } = {}) {
  const rawInput = extractInputEnvelope(body);
  const validated = validateTicketInput(rawInput, { partial: false });
  const instant = typeof now === 'function' ? now() : now;
  const formatted = formatLocalDateTime(instant, timeZone);

  return {
    ...validated,
    date: formatted,
    date_mod: formatted,
  };
}

export function parseTicketId(rawId) {
  const str = String(rawId ?? '');
  if (!/^[1-9]\d*$/.test(str)) {
    throw new TicketValidationError('O parâmetro id deve ser um inteiro >= 1.');
  }
  const id = Number(str);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new TicketValidationError('O parâmetro id deve ser um inteiro >= 1.');
  }
  return id;
}

export const MAX_RANGE_SIZE = 500;

export function parseListQuery(query = {}) {
  const rangeStr = query.range !== undefined ? String(query.range) : '0-49';
  const match = /^(\d+)-(\d+)$/.exec(rangeStr);
  if (!match) {
    throw new TicketValidationError('O parâmetro range deve estar no formato <início>-<fim>.');
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
    throw new TicketValidationError('O parâmetro range possui intervalo inválido (início > fim).');
  }
  const limit = end - start + 1;
  if (limit > MAX_RANGE_SIZE) {
    throw new TicketValidationError(
      `O parâmetro range permite no máximo ${MAX_RANGE_SIZE} itens por página.`,
    );
  }

  const sort = query.sort !== undefined ? String(query.sort) : 'date_mod';
  if (sort !== 'date_mod' && sort !== 'id') {
    throw new TicketValidationError('O parâmetro sort deve ser "date_mod" ou "id".');
  }

  const order = query.order !== undefined ? String(query.order) : 'ASC';
  if (order !== 'ASC' && order !== 'DESC') {
    throw new TicketValidationError('O parâmetro order deve ser "ASC" ou "DESC".');
  }

  let dateModGte = null;
  if (query.date_mod_gte !== undefined) {
    if (!isGlpiDateTime(query.date_mod_gte)) {
      throw new TicketValidationError(
        'O parâmetro date_mod_gte deve estar no formato YYYY-MM-DD HH:MM:SS.',
      );
    }
    dateModGte = query.date_mod_gte;
  }

  return { offset: start, start, end, limit, sort, order, dateModGte };
}

export function buildListMeta({ start, count, total }) {
  if (total === 0 || count === 0 || start >= total) {
    return {
      statusCode: 200,
      contentRange: `*/${total}`,
    };
  }
  const actualEnd = start + count - 1;
  const isComplete = start === 0 && count === total;
  return {
    statusCode: isComplete ? 200 : 206,
    contentRange: `${start}-${actualEnd}/${total}`,
  };
}
