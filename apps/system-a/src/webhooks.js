import crypto from 'node:crypto';

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
