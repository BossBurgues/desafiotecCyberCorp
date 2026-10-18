import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import YAML from 'yaml';
import { PROFILES } from '../../src/auth.js';
import { sign } from '../../src/webhooks.js';
import { buildTestServer, login } from '../helpers/session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractPath = path.resolve(__dirname, '../../../../contracts/system-a.openapi.yaml');
const openapiDoc = YAML.parse(fs.readFileSync(contractPath, 'utf8'));
const schemaPath = path.resolve(
  __dirname,
  '../../../../contracts/events/ticket-changed.schema.json',
);
const eventSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

function createWebhookValidators() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const validateEvent = ajv.compile(eventSchema);

  const params = openapiDoc.webhooks['ticket.changed'].post.parameters;
  const sigParam = params.find((p) => p.name === 'X-Signature-256');
  const tsParam = params.find((p) => p.name === 'X-Timestamp');
  const sigPattern = new RegExp(sigParam.schema.pattern);
  const tsPattern = new RegExp(tsParam.schema.pattern);

  return { ajv, validateEvent, sigPattern, tsPattern };
}

async function startReceiver({ delayMs = 0, statusCode = 200 } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        rawBody,
      });
      if (delayMs > 0) {
        setTimeout(() => {
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        }, delayMs).unref();
      } else {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/webhooks/system-a`;

  return {
    url,
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('criar chamado envia webhook created que o receptor verifica com o HMAC_SECRET e valida no contrato', async () => {
  const { ajv, validateEvent, sigPattern, tsPattern } = createWebhookValidators();
  const receiver = await startReceiver();
  const secret = 'segredo-hmac-integracao-0123456789abcdef';
  const fixedNow = Date.parse('2026-10-18T17:03:22Z');

  const app = buildTestServer({
    timeZone: 'America/Sao_Paulo',
    now: () => fixedNow,
    webhook: {
      enabled: true,
      url: receiver.url,
      secret,
      dropRate: 0,
    },
  });

  try {
    const headers = await login(app, PROFILES.TECNICO);
    const res = await app.inject({
      method: 'POST',
      url: '/apirest.php/Ticket',
      headers,
      payload: {
        input: {
          name: 'Chamado com webhook created',
          content: 'Corpo do chamado',
        },
      },
    });
    assert.equal(res.statusCode, 201);
    const created = res.json();

    await app.webhook.close();

    assert.equal(receiver.received.length, 1);
    const req = receiver.received[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/webhooks/system-a');

    const sigHeader = req.headers['x-signature-256'];
    const tsHeader = req.headers['x-timestamp'];
    assert.match(sigHeader, sigPattern, 'X-Signature-256 deve bater com o pattern do OpenAPI');
    assert.match(tsHeader, tsPattern, 'X-Timestamp deve bater com o pattern do OpenAPI');

    const expectedSig = sign(secret, tsHeader, req.rawBody);
    const sigBuf = Buffer.from(sigHeader, 'utf8');
    const expBuf = Buffer.from(expectedSig, 'utf8');
    assert.equal(sigBuf.length, expBuf.length);
    assert.equal(crypto.timingSafeEqual(sigBuf, expBuf), true);

    const parsedBody = JSON.parse(req.rawBody);
    assert.equal(
      validateEvent(parsedBody),
      true,
      `Payload divergiu de ticket-changed.schema.json: ${ajv.errorsText(validateEvent.errors)}`,
    );
    assert.equal(parsedBody.ticket_id, created.id);
    assert.equal(parsedBody.action, 'created');
    assert.equal(parsedBody.date_mod, created.date_mod);
    assert.equal(parsedBody.occurred_at, '2026-10-18T17:03:22Z');
  } finally {
    await app.close();
    await receiver.close();
  }
});

test('editar chamado envia webhook updated com o date_mod salvo', async () => {
  const { ajv, validateEvent } = createWebhookValidators();
  const receiver = await startReceiver();
  const secret = 'segredo-hmac-integracao-0123456789abcdef';
  const instants = [
    Date.parse('2026-10-18T16:50:00Z'),
    Date.parse('2026-10-18T17:03:22Z'),
  ];
  let idx = 0;

  const app = buildTestServer({
    timeZone: 'America/Sao_Paulo',
    now: () => instants[Math.min(idx++, instants.length - 1)],
    webhook: {
      enabled: true,
      url: receiver.url,
      secret,
      dropRate: 0,
    },
  });

  try {
    const headers = await login(app, PROFILES.TECNICO);
    idx = 0;

    const createRes = await app.inject({
      method: 'POST',
      url: '/apirest.php/Ticket',
      headers,
      payload: {
        input: {
          name: 'Chamado inicial',
          content: 'Descrição inicial',
        },
      },
    });
    assert.equal(createRes.statusCode, 201);
    const created = createRes.json();

    const updateRes = await app.inject({
      method: 'PUT',
      url: `/apirest.php/Ticket/${created.id}`,
      headers,
      payload: {
        input: {
          status: 2,
          priority: 4,
        },
      },
    });
    assert.equal(updateRes.statusCode, 200);
    const updated = updateRes.json();

    await app.webhook.close();

    assert.equal(receiver.received.length, 2);
    const secondReq = receiver.received[1];
    const parsed = JSON.parse(secondReq.rawBody);
    assert.equal(
      validateEvent(parsed),
      true,
      `Evento updated inválido: ${ajv.errorsText(validateEvent.errors)}`,
    );
    assert.equal(parsed.ticket_id, updated.id);
    assert.equal(parsed.action, 'updated');
    assert.equal(parsed.date_mod, updated.date_mod);
    assert.equal(parsed.date_mod, '2026-10-18 14:03:22');
  } finally {
    await app.close();
    await receiver.close();
  }
});

test('POST responde 201 mesmo com o receptor fora do ar', async () => {
  // Abre e fecha uma porta efêmera para garantir que ninguém escuta nela
  const closedReceiver = await startReceiver();
  const deadUrl = closedReceiver.url;
  await closedReceiver.close();

  const app = buildTestServer({
    webhook: {
      enabled: true,
      url: deadUrl,
      secret: 'segredo-hmac-integracao-0123456789abcdef',
      dropRate: 0,
    },
  });

  try {
    const headers = await login(app, PROFILES.TECNICO);
    const res = await app.inject({
      method: 'POST',
      url: '/apirest.php/Ticket',
      headers,
      payload: {
        input: {
          name: 'Chamado sem receptor',
          content: 'Deve responder 201 normalmente',
        },
      },
    });
    assert.equal(res.statusCode, 201);
    await app.webhook.close();
  } finally {
    await app.close();
  }
});

test('receptor lento não atrasa a resposta do A', async () => {
  const receiver = await startReceiver({ delayMs: 3000 });

  const app = buildTestServer({
    webhook: {
      enabled: true,
      url: receiver.url,
      secret: 'segredo-hmac-integracao-0123456789abcdef',
      dropRate: 0,
    },
  });

  try {
    const headers = await login(app, PROFILES.TECNICO);
    const startedAt = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/apirest.php/Ticket',
      headers,
      payload: {
        input: {
          name: 'Chamado com receptor lento',
          content: 'Fire-and-forget não bloqueia',
        },
      },
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(res.statusCode, 201);
    assert.ok(
      elapsedMs < 500,
      `POST /Ticket demorou ${elapsedMs}ms (esperado < 500ms mesmo com receptor segurando 3s)`,
    );

    await app.webhook.close();
  } finally {
    await app.close();
    await receiver.close();
  }
});

test('estagiário barrado com 403 não gera webhook', async () => {
  const receiver = await startReceiver();

  const app = buildTestServer({
    webhook: {
      enabled: true,
      url: receiver.url,
      secret: 'segredo-hmac-integracao-0123456789abcdef',
      dropRate: 0,
    },
  });

  try {
    const tecnicoHeaders = await login(app, PROFILES.TECNICO);
    const createRes = await app.inject({
      method: 'POST',
      url: '/apirest.php/Ticket',
      headers: tecnicoHeaders,
      payload: {
        input: {
          name: 'Chamado para testar 403',
          content: 'Criado pelo técnico',
        },
      },
    });
    assert.equal(createRes.statusCode, 201);
    const created = createRes.json();
    await app.webhook.close();
    assert.equal(receiver.received.length, 1);

    const estagiarioHeaders = await login(app, PROFILES.ESTAGIARIO);
    const forbiddenRes = await app.inject({
      method: 'PUT',
      url: `/apirest.php/Ticket/${created.id}`,
      headers: estagiarioHeaders,
      payload: {
        input: {
          status: 2,
        },
      },
    });
    assert.equal(forbiddenRes.statusCode, 403);
    await app.webhook.close();

    assert.equal(receiver.received.length, 1, 'PUT negado com 403 não deve disparar webhook');
  } finally {
    await app.close();
    await receiver.close();
  }
});

test('com A_WEBHOOK_DROP_RATE=100 nada chega ao receptor e o chamado é criado', async () => {
  const receiver = await startReceiver();

  const app = buildTestServer({
    webhook: {
      enabled: true,
      url: receiver.url,
      secret: 'segredo-hmac-integracao-0123456789abcdef',
      dropRate: 100,
    },
  });

  try {
    const headers = await login(app, PROFILES.TECNICO);
    const res = await app.inject({
      method: 'POST',
      url: '/apirest.php/Ticket',
      headers,
      payload: {
        input: {
          name: 'Chamado com drop 100%',
          content: 'Simula perda total de webhooks (cenário B2)',
        },
      },
    });
    assert.equal(res.statusCode, 201);
    await app.webhook.close();

    assert.equal(receiver.received.length, 0);
  } finally {
    await app.close();
    await receiver.close();
  }
});
