import crypto from 'node:crypto';

export const PROFILES = Object.freeze({
  TECNICO: 'tecnico',
  ESTAGIARIO: 'estagiario',
  SYNC_BOT: 'sync-bot',
});

export const ACTIONS = Object.freeze({
  TICKET_READ: 'ticket.read',
  TICKET_CREATE: 'ticket.create',
  TICKET_UPDATE: 'ticket.update',
  FOLLOWUP_CREATE: 'followup.create',
  SOLUTION_CREATE: 'solution.create',
  SOLUTION_DECIDE: 'solution.decide',
});

export const DEFAULT_DEV_CREDENTIALS = Object.freeze({
  appToken: 'dev-app-token',
  tecnicoPassword: 'dev-tecnico-password',
  estagiarioPassword: 'dev-estagiario-password',
  syncBotToken: 'dev-sync-bot-token',
});

const PERMISSION_MATRIX = Object.freeze({
  [PROFILES.TECNICO]: new Set([
    ACTIONS.TICKET_READ,
    ACTIONS.TICKET_CREATE,
    ACTIONS.TICKET_UPDATE,
    ACTIONS.FOLLOWUP_CREATE,
    ACTIONS.SOLUTION_CREATE,
    ACTIONS.SOLUTION_DECIDE,
  ]),
  [PROFILES.ESTAGIARIO]: new Set([ACTIONS.TICKET_READ, ACTIONS.TICKET_CREATE]),
  // No M1 o sync-bot apenas lê chamados; escritas de nota (S1.4) e proposta de solução (S1.5/M3) já ficam declaradas.
  [PROFILES.SYNC_BOT]: new Set([
    ACTIONS.TICKET_READ,
    ACTIONS.FOLLOWUP_CREATE,
    ACTIONS.SOLUTION_CREATE,
  ]),
});

const KNOWN_ACTIONS = new Set(Object.values(ACTIONS));

export class AuthError extends Error {
  constructor(glpiCode, message, statusCode = 401, context = {}) {
    super(message);
    this.name = 'AuthError';
    this.glpiCode = glpiCode;
    this.statusCode = statusCode;
    this.context = context;
  }
}

export class ForbiddenError extends AuthError {
  constructor(profile, action) {
    super('ERROR_RIGHT_MISSING', `Perfil ${profile} não pode executar ${action}.`, 403, {
      action,
    });
    this.name = 'ForbiddenError';
  }
}

export function can(profile, action) {
  if (!KNOWN_ACTIONS.has(action)) {
    throw new Error(`Ação de permissão desconhecida: ${String(action)}.`);
  }
  const allowed = PERMISSION_MATRIX[profile];
  if (!allowed) {
    return false;
  }
  return allowed.has(action);
}

export function parseAuthorization(header) {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new AuthError(
      'ERROR_LOGIN_PARAMETERS_MISSING',
      'Cabeçalho Authorization ausente na abertura de sessão.',
      401,
    );
  }

  const trimmed = header.trim();
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) {
    throw new AuthError(
      'ERROR_LOGIN_PARAMETERS_MISSING',
      'Formato inválido no cabeçalho Authorization.',
      401,
    );
  }

  const scheme = trimmed.slice(0, spaceIdx);
  const credential = trimmed.slice(spaceIdx + 1).trim();

  if (scheme === 'Basic') {
    if (!credential || !/^[A-Za-z0-9+/]+=*$/.test(credential) || credential.length % 4 !== 0) {
      throw new AuthError(
        'ERROR_LOGIN_PARAMETERS_MISSING',
        'Credencial Basic em Base64 inválida.',
        401,
      );
    }
    const decoded = Buffer.from(credential, 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx <= 0) {
      throw new AuthError(
        'ERROR_LOGIN_PARAMETERS_MISSING',
        'Credencial Basic deve estar no formato login:senha.',
        401,
      );
    }
    const login = decoded.slice(0, colonIdx);
    const password = decoded.slice(colonIdx + 1);
    if (!password) {
      throw new AuthError(
        'ERROR_LOGIN_PARAMETERS_MISSING',
        'Senha ausente na credencial Basic.',
        401,
      );
    }
    return { kind: 'basic', login, password };
  }

  if (scheme === 'user_token') {
    if (!credential) {
      throw new AuthError(
        'ERROR_LOGIN_PARAMETERS_MISSING',
        'Token ausente no esquema user_token.',
        401,
      );
    }
    return { kind: 'user_token', token: credential };
  }

  throw new AuthError(
    'ERROR_LOGIN_PARAMETERS_MISSING',
    'Esquema de autenticação não suportado; use Basic ou user_token.',
    401,
  );
}

export function validateAppTokenHeader(headerValue, expectedAppToken) {
  if (typeof headerValue !== 'string' || headerValue.trim() === '') {
    throw new AuthError(
      'ERROR_APP_TOKEN_PARAMETERS_MISSING',
      'Cabeçalho App-Token ausente.',
      401,
    );
  }
  const providedBuf = Buffer.from(headerValue);
  const expectedBuf = Buffer.from(String(expectedAppToken));
  if (
    providedBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(providedBuf, expectedBuf)
  ) {
    throw new AuthError('ERROR_WRONG_APP_TOKEN_PARAMETER', 'Cabeçalho App-Token inválido.', 401);
  }
}

export function validateSessionTokenHeader(headerValue, store) {
  if (typeof headerValue !== 'string' || headerValue.trim() === '') {
    throw new AuthError('ERROR_SESSION_TOKEN_MISSING', 'Cabeçalho Session-Token ausente.', 401);
  }
  const token = headerValue.trim();
  const user = store.getSessionUser(token);
  if (!user) {
    throw new AuthError('ERROR_SESSION_TOKEN_INVALID', 'Cabeçalho Session-Token inválido.', 401);
  }
  return { token, user };
}

export function hashPassword(plain, saltHex = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(plain), Buffer.from(saltHex, 'hex'), 64);
  return `scrypt$${saltHex}$${derived.toString('hex')}`;
}

export function verifyPassword(plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string') {
    return false;
  }
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, saltHex, hashHex] = parts;
  if (!saltHex || !hashHex) {
    return false;
  }
  const expectedBuf = Buffer.from(hashHex, 'hex');
  const derivedBuf = crypto.scryptSync(plain, Buffer.from(saltHex, 'hex'), expectedBuf.length);
  if (derivedBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(derivedBuf, expectedBuf);
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

export function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function loadAuthConfig(env = process.env, overrides = {}) {
  const isProd = env.NODE_ENV === 'production';
  const requiredVars = [
    ['appToken', 'A_APP_TOKEN'],
    ['tecnicoPassword', 'A_TECNICO_PASSWORD'],
    ['estagiarioPassword', 'A_ESTAGIARIO_PASSWORD'],
    ['syncBotToken', 'A_SYNC_BOT_TOKEN'],
  ];

  const resolved = {};
  for (const [key, envName] of requiredVars) {
    const val = overrides[key] !== undefined ? overrides[key] : env[envName];
    if (typeof val === 'string' && val.trim() !== '') {
      resolved[key] = val;
    } else if (isProd) {
      throw new Error(
        `Variável obrigatória ${envName} ausente em NODE_ENV=production no Sistema A.`,
      );
    } else {
      resolved[key] = DEFAULT_DEV_CREDENTIALS[key];
    }
  }

  return resolved;
}
