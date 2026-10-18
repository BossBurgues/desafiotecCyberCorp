import crypto from 'node:crypto';
import { PROFILES } from './auth.js';

export const WEBHOOK_TIMEOUT_MS = 2000;
export const MIN_PROD_SECRET_LENGTH = 32;

export function toUnixSeconds(ms) {
  return Math.floor(Number(ms) / 1000);
}

export function toUtcIsoSeconds(ms) {
  return `${new Date(toUnixSeconds(ms) * 1000).toISOString().slice(0, 19)}Z`;
}

export function buildEvent(
  { ticketId, action, dateMod },
  { now = Date.now, uuid = crypto.randomUUID } = {},
) {
  const instant = typeof now === 'function' ? now() : now;
  const event = {
    schema_version: 1,
    event_id: uuid(),
    type: 'ticket.changed',
    ticket_id: ticketId,
    action,
    occurred_at: toUtcIsoSeconds(instant),
  };
  if (dateMod !== undefined && dateMod !== null) {
    event.date_mod = dateMod;
  }
  return event;
}

export function sign(secret, timestamp, rawBody) {
  const hex = crypto
    .createHmac('sha256', String(secret))
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
  return `sha256=${hex}`;
}

export function serialize(event, { secret, now = Date.now } = {}) {
  const instant =
    event?.occurred_at !== undefined
      ? Date.parse(event.occurred_at)
      : typeof now === 'function'
        ? now()
        : now;
  const timestamp = String(toUnixSeconds(instant));
  const rawBody = JSON.stringify(event);
  const signature = sign(secret, timestamp, rawBody);
  return {
    rawBody,
    timestamp,
    signature,
    headers: {
      'Content-Type': 'application/json',
      'X-Timestamp': timestamp,
      'X-Signature-256': signature,
    },
  };
}

function parseEnabled(rawEnabled) {
  if (typeof rawEnabled === 'boolean') {
    return rawEnabled;
  }
  if (typeof rawEnabled === 'string') {
    return rawEnabled.trim().toLowerCase() === 'true';
  }
  return false;
}

function parseDropRate(rawDropRate) {
  if (rawDropRate === undefined || rawDropRate === null || rawDropRate === '') {
    return 0;
  }
  const str = String(rawDropRate).trim();
  if (str === '') {
    return 0;
  }
  const num = Number(str);
  if (!Number.isFinite(num) || num < 0 || num > 100) {
    throw new Error(
      'Configuração inválida em A_WEBHOOK_DROP_RATE: informe um número entre 0 e 100.',
    );
  }
  return num;
}

function parseWebhookUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw new Error(
      'Configuração inválida: A_WEBHOOK_URL é obrigatória quando A_WEBHOOK_ENABLED=true.',
    );
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Configuração inválida em A_WEBHOOK_URL: informe uma URL HTTP ou HTTPS válida.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Configuração inválida em A_WEBHOOK_URL: protocolo deve ser http: ou https:.');
  }
  return parsed.toString();
}

function parseHmacSecret(rawSecret, isProd) {
  if (typeof rawSecret !== 'string' || rawSecret.trim() === '') {
    throw new Error(
      'Configuração inválida: HMAC_SECRET é obrigatório quando A_WEBHOOK_ENABLED=true.',
    );
  }
  if (isProd && rawSecret.length < MIN_PROD_SECRET_LENGTH) {
    throw new Error(
      `Configuração inválida: HMAC_SECRET deve ter pelo menos ${MIN_PROD_SECRET_LENGTH} caracteres em NODE_ENV=production.`,
    );
  }
  return rawSecret;
}

export function loadWebhookConfig(env = process.env, overrides = {}) {
  const isProd = env.NODE_ENV === 'production';
  const rawEnabled =
    overrides.enabled !== undefined ? overrides.enabled : env.A_WEBHOOK_ENABLED;
  const enabled = parseEnabled(rawEnabled);

  const rawDropRate =
    overrides.dropRate !== undefined ? overrides.dropRate : env.A_WEBHOOK_DROP_RATE;
  const dropRate = parseDropRate(rawDropRate);

  if (!enabled) {
    return {
      enabled: false,
      url: null,
      secret: null,
      dropRate,
    };
  }

  const rawUrl = overrides.url !== undefined ? overrides.url : env.A_WEBHOOK_URL;
  const url = parseWebhookUrl(rawUrl);

  const rawSecret = overrides.secret !== undefined ? overrides.secret : env.HMAC_SECRET;
  const secret = parseHmacSecret(rawSecret, isProd);

  return {
    enabled: true,
    url,
    secret,
    dropRate,
  };
}

const NOOP_LOG = Object.freeze({
  info() {},
  warn() {},
  debug() {},
  error() {},
});

export function createWebhookDispatcher(
  config,
  {
    fetch: fetchImpl = globalThis.fetch,
    now = Date.now,
    uuid = crypto.randomUUID,
    log = NOOP_LOG,
  } = {},
) {
  const pending = new Set();

  async function send(event, headers, rawBody) {
    const startedAt = Date.now();
    try {
      const response = await fetchImpl(config.url, {
        method: 'POST',
        headers,
        body: rawBody,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      const ms = Date.now() - startedAt;
      if (response.ok) {
        log.info(
          {
            event_id: event.event_id,
            ticket_id: event.ticket_id,
            action: event.action,
            status: response.status,
            ms,
          },
          'webhook enviado',
        );
      } else {
        log.warn(
          {
            event_id: event.event_id,
            ticket_id: event.ticket_id,
            action: event.action,
            status: response.status,
            ms,
          },
          'webhook falhou: resposta não-2xx do receptor',
        );
      }
    } catch (err) {
      const ms = Date.now() - startedAt;
      log.warn(
        {
          event_id: event.event_id,
          ticket_id: event.ticket_id,
          action: event.action,
          reason: err?.message || String(err),
          ms,
        },
        'webhook falhou',
      );
    }
  }

  function handle(change) {
    try {
      // Barreira 2 do anti-eco (ADR-009): escritas feitas pelo sync-bot nunca disparam webhook A -> B.
      if (change?.actor?.profile === PROFILES.SYNC_BOT) {
        log.debug(
          { ticket_id: change.ticketId, action: change.action },
          'webhook ignorado: mudança do sync-bot',
        );
        return;
      }

      if (!config?.enabled) {
        return;
      }

      const event = buildEvent(
        {
          ticketId: change.ticketId,
          action: change.action,
          dateMod: change.dateMod,
        },
        { now, uuid },
      );

      const { rawBody, headers } = serialize(event, { secret: config.secret, now });
      const task = send(event, headers, rawBody).finally(() => {
        pending.delete(task);
      });
      pending.add(task);
    } catch (err) {
      log.warn(
        {
          ticket_id: change?.ticketId,
          action: change?.action,
          reason: err?.message || String(err),
        },
        'webhook falhou',
      );
    }
  }

  async function close() {
    await Promise.allSettled([...pending]);
  }

  return {
    config,
    handle,
    close,
    get pendingCount() {
      return pending.size;
    },
  };
}
