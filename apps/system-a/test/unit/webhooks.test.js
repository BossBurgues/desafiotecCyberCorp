import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { PROFILES } from '../../src/auth.js';
import {
  buildEvent,
  createWebhookDispatcher,
  loadWebhookConfig,
  serialize,
  shouldDrop,
  sign,
  toUnixSeconds,
  toUtcIsoSeconds,
} from '../../src/webhooks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(
  __dirname,
  '../../../../contracts/events/ticket-changed.schema.json',
);
const eventSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

function createSchemaValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(eventSchema);
  return { ajv, validate };
}

test("assinatura é sha256=<hex> do HMAC de '<timestamp>.<corpo cru>'", () => {
  const secret = 'segredo-fixo-de-teste-0123456789abcdef';
  const timestamp = '1792343002';
  const rawBody =
    '{"schema_version":1,"event_id":"11111111-2222-4333-8444-555555555555","type":"ticket.changed","ticket_id":42,"action":"created","occurred_at":"2026-10-18T17:03:22Z","date_mod":"2026-10-18 14:03:22"}';

  const expectedHex = 'd67e089f9830fa037e2bbd38d1c6cdcfe74f922aa947802be8f2c604114c60ff';
  assert.equal(sign(secret, timestamp, rawBody), `sha256=${expectedHex}`);
});

test('mudar um byte do corpo ou o timestamp muda a assinatura', () => {
  const secret = 'segredo-fixo-de-teste-0123456789abcdef';
  const timestamp = '1792343002';
  const rawBody = '{"ticket_id":42,"action":"created"}';

  const baseSig = sign(secret, timestamp, rawBody);
  const bodyChangedSig = sign(secret, timestamp, '{"ticket_id":43,"action":"created"}');
  const tsChangedSig = sign(secret, '1792343003', rawBody);
  const secretChangedSig = sign('outro-segredo', timestamp, rawBody);

  assert.notEqual(baseSig, bodyChangedSig);
  assert.notEqual(baseSig, tsChangedSig);
  assert.notEqual(baseSig, secretChangedSig);
});

test('evento created e updated validam contra ticket-changed.schema.json', () => {
  const { ajv, validate } = createSchemaValidator();
  const fixedNow = Date.parse('2026-10-18T17:03:22.789Z');

  const createdEvent = buildEvent(
    { ticketId: 42, action: 'created', dateMod: '2026-10-18 14:03:22' },
    { now: fixedNow },
  );
  assert.equal(
    validate(createdEvent),
    true,
    `Evento created inválido: ${ajv.errorsText(validate.errors)}`,
  );

  const updatedEvent = buildEvent(
    { ticketId: 42, action: 'updated' },
    { now: fixedNow },
  );
  assert.equal(
    validate(updatedEvent),
    true,
    `Evento updated sem date_mod inválido: ${ajv.errorsText(validate.errors)}`,
  );

  assert.equal(
    validate({ ...createdEvent, extra: true }),
    false,
    'Schema deve rejeitar campos adicionais (additionalProperties: false)',
  );
});

test('occurred_at é UTC sem milissegundos e X-Timestamp é o mesmo instante em segundos', () => {
  const fixedNow = Date.parse('2026-10-18T17:03:22.987Z');
  const event = buildEvent(
    { ticketId: 7, action: 'created', dateMod: '2026-10-18 14:03:22' },
    { now: fixedNow },
  );

  assert.equal(toUtcIsoSeconds(fixedNow), '2026-10-18T17:03:22Z');
  assert.equal(toUnixSeconds(fixedNow), 1792343002);
  assert.equal(event.occurred_at, '2026-10-18T17:03:22Z');

  const serialized = serialize(event, { secret: 'segredo-de-teste', now: fixedNow });
  assert.equal(serialized.timestamp, '1792343002');
  assert.equal(serialized.headers['X-Timestamp'], '1792343002');
  assert.equal(
    serialized.headers['X-Signature-256'],
    sign('segredo-de-teste', '1792343002', serialized.rawBody),
  );
});

test('cada disparo tem event_id próprio', () => {
  const ev1 = buildEvent({ ticketId: 1, action: 'created' });
  const ev2 = buildEvent({ ticketId: 1, action: 'created' });

  assert.notEqual(ev1.event_id, ev2.event_id);
  assert.match(
    ev1.event_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
});

test('mudança do sync-bot não chama fetch', async () => {
  let fetchCalls = 0;
  const debugLogs = [];
  const dispatcher = createWebhookDispatcher(
    {
      enabled: true,
      url: 'http://127.0.0.1:9999/webhooks/system-a',
      secret: 'segredo-de-teste-0123456789abcdef',
      dropRate: 0,
    },
    {
      fetch: async () => {
        fetchCalls += 1;
        return { ok: true, status: 200 };
      },
      log: {
        info() {},
        warn() {},
        error() {},
        debug(obj, msg) {
          debugLogs.push({ obj, msg });
        },
      },
    },
  );

  dispatcher.handle({
    ticketId: 10,
    action: 'updated',
    dateMod: '2026-10-18 14:03:22',
    actor: { id: 3, login: 'sync-bot', profile: PROFILES.SYNC_BOT },
  });
  await dispatcher.close();

  assert.equal(fetchCalls, 0);
  assert.equal(debugLogs.length, 1);
  assert.equal(debugLogs[0].msg, 'webhook ignorado: mudança do sync-bot');
});

test('webhook desligado não chama fetch', async () => {
  let fetchCalls = 0;
  const dispatcher = createWebhookDispatcher(
    {
      enabled: false,
      url: null,
      secret: null,
      dropRate: 0,
    },
    {
      fetch: async () => {
        fetchCalls += 1;
        return { ok: true, status: 200 };
      },
    },
  );

  dispatcher.handle({
    ticketId: 10,
    action: 'created',
    dateMod: '2026-10-18 14:03:22',
    actor: { id: 1, login: 'tecnico', profile: PROFILES.TECNICO },
  });
  await dispatcher.close();

  assert.equal(fetchCalls, 0);
});

test('drop rate 0 nunca descarta, 100 sempre descarta e 30 descarta quando random < 0,30', async () => {
  assert.equal(shouldDrop(0, () => 0), false);
  assert.equal(shouldDrop(0, () => 0.999), false);
  assert.equal(shouldDrop(100, () => 0), true);
  assert.equal(shouldDrop(100, () => 0.999), true);
  assert.equal(shouldDrop(30, () => 0.299), true);
  assert.equal(shouldDrop(30, () => 0.3), false);

  let fetchCalls = 0;
  const infoLogs = [];
  const dispatcher = createWebhookDispatcher(
    {
      enabled: true,
      url: 'http://127.0.0.1:9999/webhooks/system-a',
      secret: 'segredo-de-teste-0123456789abcdef',
      dropRate: 30,
    },
    {
      random: () => 0.15,
      uuid: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      fetch: async () => {
        fetchCalls += 1;
        return { ok: true, status: 200 };
      },
      log: {
        info(obj, msg) {
          infoLogs.push({ obj, msg });
        },
        warn() {},
        debug() {},
        error() {},
      },
    },
  );

  dispatcher.handle({
    ticketId: 55,
    action: 'created',
    dateMod: '2026-10-18 14:03:22',
    actor: { id: 1, login: 'tecnico', profile: PROFILES.TECNICO },
  });
  await dispatcher.close();

  assert.equal(fetchCalls, 0);
  assert.equal(infoLogs.length, 1);
  assert.equal(infoLogs[0].msg, 'webhook descartado (A_WEBHOOK_DROP_RATE)');
  assert.equal(infoLogs[0].obj.event_id, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal(infoLogs[0].obj.ticket_id, 55);
});

test('falha de rede, timeout e resposta 500 não lançam e geram warn', async () => {
  const warnLogs = [];
  const outcomes = [
    async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:9999');
    },
    async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    },
    async () => ({ ok: false, status: 500 }),
  ];
  let callIdx = 0;

  const dispatcher = createWebhookDispatcher(
    {
      enabled: true,
      url: 'http://127.0.0.1:9999/webhooks/system-a',
      secret: 'segredo-de-teste-0123456789abcdef',
      dropRate: 0,
    },
    {
      fetch: (...args) => outcomes[callIdx++](...args),
      log: {
        info() {},
        warn(obj, msg) {
          warnLogs.push({ obj, msg });
        },
        debug() {},
        error() {},
      },
    },
  );

  for (let i = 1; i <= 3; i += 1) {
    assert.doesNotThrow(() => {
      dispatcher.handle({
        ticketId: i,
        action: 'created',
        actor: { id: 1, login: 'tecnico', profile: PROFILES.TECNICO },
      });
    });
  }
  await dispatcher.close();

  assert.equal(warnLogs.length, 3);
  assert.match(warnLogs[0].obj.reason, /ECONNREFUSED/);
  assert.match(warnLogs[1].obj.reason, /timeout/i);
  assert.equal(warnLogs[2].obj.status, 500);
});

test('ligado sem URL ou sem HMAC_SECRET não sobe, drop rate fora de 0–100 não sobe e em produção HMAC_SECRET curto não sobe', () => {
  const disabled = loadWebhookConfig({ A_WEBHOOK_ENABLED: 'false' });
  assert.deepEqual(disabled, {
    enabled: false,
    url: null,
    secret: null,
    dropRate: 0,
  });

  assert.throws(
    () =>
      loadWebhookConfig({
        A_WEBHOOK_ENABLED: 'true',
        HMAC_SECRET: 'segredo-valido-0123456789abcdef0123',
      }),
    /A_WEBHOOK_URL/,
  );

  assert.throws(
    () =>
      loadWebhookConfig({
        A_WEBHOOK_ENABLED: 'true',
        A_WEBHOOK_URL: 'ftp://localhost/webhook',
        HMAC_SECRET: 'segredo-valido-0123456789abcdef0123',
      }),
    /A_WEBHOOK_URL/,
  );

  assert.throws(
    () =>
      loadWebhookConfig({
        A_WEBHOOK_ENABLED: 'true',
        A_WEBHOOK_URL: 'http://localhost:3000/webhooks/system-a',
      }),
    /HMAC_SECRET/,
  );

  assert.throws(
    () =>
      loadWebhookConfig({
        A_WEBHOOK_ENABLED: 'false',
        A_WEBHOOK_DROP_RATE: '150',
      }),
    /A_WEBHOOK_DROP_RATE/,
  );

  assert.throws(
    () =>
      loadWebhookConfig({
        A_WEBHOOK_ENABLED: 'false',
        A_WEBHOOK_DROP_RATE: '-5',
      }),
    /A_WEBHOOK_DROP_RATE/,
  );

  assert.throws(
    () =>
      loadWebhookConfig({
        A_WEBHOOK_ENABLED: 'false',
        A_WEBHOOK_DROP_RATE: 'abc',
      }),
    /A_WEBHOOK_DROP_RATE/,
  );

  assert.throws(
    () =>
      loadWebhookConfig({
        NODE_ENV: 'production',
        A_WEBHOOK_ENABLED: 'true',
        A_WEBHOOK_URL: 'http://sync:3000/webhooks/system-a',
        HMAC_SECRET: 'segredo-curto',
      }),
    /32 caracteres/,
  );

  const validProd = loadWebhookConfig({
    NODE_ENV: 'production',
    A_WEBHOOK_ENABLED: 'true',
    A_WEBHOOK_URL: 'http://sync:3000/webhooks/system-a',
    A_WEBHOOK_DROP_RATE: '12.5',
    HMAC_SECRET: '0123456789abcdef0123456789abcdef',
  });
  assert.equal(validProd.enabled, true);
  assert.equal(validProd.dropRate, 12.5);
});

test('log do disparo não contém o segredo nem a assinatura', async () => {
  const secret = 'segredo-super-sensivel-que-nao-pode-vazar-no-log';
  const logs = [];
  const recordLog = (level) => (obj, msg) => {
    logs.push(JSON.stringify({ level, obj, msg }));
  };

  let sentSignature = null;
  const dispatcher = createWebhookDispatcher(
    {
      enabled: true,
      url: 'http://127.0.0.1:9999/webhooks/system-a',
      secret,
      dropRate: 0,
    },
    {
      fetch: async (_url, init) => {
        sentSignature = init.headers['X-Signature-256'];
        return { ok: true, status: 200 };
      },
      log: {
        info: recordLog('info'),
        warn: recordLog('warn'),
        debug: recordLog('debug'),
        error: recordLog('error'),
      },
    },
  );

  dispatcher.handle({
    ticketId: 99,
    action: 'created',
    dateMod: '2026-10-18 14:03:22',
    actor: { id: 1, login: 'tecnico', profile: PROFILES.TECNICO },
  });
  await dispatcher.close();

  assert.ok(sentSignature && sentSignature.startsWith('sha256='));
  assert.equal(logs.length, 1);
  const combinedLogs = logs.join('\n');
  assert.equal(combinedLogs.includes(secret), false, 'Segredo não deve aparecer nos logs');
  assert.equal(
    combinedLogs.includes(sentSignature),
    false,
    'Assinatura não deve aparecer nos logs',
  );
  assert.equal(
    combinedLogs.includes(sentSignature.slice('sha256='.length)),
    false,
    'Hex da assinatura não deve aparecer nos logs',
  );
});
