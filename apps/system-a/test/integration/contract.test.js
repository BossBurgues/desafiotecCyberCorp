import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import YAML from 'yaml';
import { buildTestServer, login } from '../helpers/session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractPath = path.resolve(__dirname, '../../../../contracts/system-a.openapi.yaml');
const openapiDoc = YAML.parse(fs.readFileSync(contractPath, 'utf8'));
const eventSchemaPath = path.resolve(
  __dirname,
  '../../../../contracts/events/ticket-changed.schema.json',
);
const eventSchema = JSON.parse(fs.readFileSync(eventSchemaPath, 'utf8'));

function createContractValidators() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(openapiDoc, 'openapi');

  const validateTicket = ajv.getSchema('openapi#/components/schemas/Ticket');
  const validateGlpiError = ajv.getSchema('openapi#/components/schemas/GlpiError');
  const validateInitSession = ajv.compile(
    openapiDoc.paths['/initSession'].get.responses['200'].content['application/json'].schema,
  );
  assert.ok(validateTicket, 'Schema Ticket deve existir em contracts/system-a.openapi.yaml');
  assert.ok(validateGlpiError, 'Schema GlpiError deve existir em contracts/system-a.openapi.yaml');

  return { ajv, validateTicket, validateGlpiError, validateInitSession };
}

test('respostas de POST, GET, PUT, listagem, initSession e erros 401/403/404 respeitam contracts/system-a.openapi.yaml', async () => {
  const { ajv, validateTicket, validateGlpiError, validateInitSession } =
    createContractValidators();

  const instants = [
    Date.parse('2026-10-18T16:50:00Z'), // 2026-10-18 13:50:00 em America/Sao_Paulo
    Date.parse('2026-10-18T17:03:22Z'), // 2026-10-18 14:03:22 em America/Sao_Paulo
  ];
  let idx = 0;

  const app = buildTestServer({
    timeZone: 'America/Sao_Paulo',
    now: () => instants[Math.min(idx++, instants.length - 1)],
  });

  try {
    const initRes = await app.inject({
      method: 'GET',
      url: '/apirest.php/initSession',
      headers: {
        'App-Token': app.authConfig.appToken,
        Authorization: `Basic ${Buffer.from(`tecnico:${app.authConfig.tecnicoPassword}`).toString('base64')}`,
      },
    });
    assert.equal(initRes.statusCode, 200);
    const initBody = initRes.json();
    assert.equal(
      validateInitSession(initBody),
      true,
      `GET /initSession divergiu do contrato: ${ajv.errorsText(validateInitSession.errors)}`,
    );

    const headers = {
      'App-Token': app.authConfig.appToken,
      'Session-Token': initBody.session_token,
    };

    const estagiarioHeaders = await login(app, 'estagiario');

    // Reinicia índice do relógio antes de criar o chamado de exemplo
    idx = 0;

    // Reserva IDs 1..41 no SQLite para que o próximo chamado criado pela API receba id 42 (mesmo exemplo do contrato e de S3.2).
    app.store.db.exec("INSERT INTO sqlite_sequence (name, seq) VALUES ('tickets', 41)");

    const createRes = await app.inject({
      method: 'POST',
      url: '/apirest.php/Ticket',
      headers,
      payload: {
        input: {
          name: 'Impressora do 3º andar não imprime',
          content: '<p>A impressora da recepção parou de responder após queda de energia.</p>',
          status: 1,
          priority: 3,
          itilcategories_id: 3,
          locations_id: 1,
          users_id_recipient: 2,
          users_id_assign: 1,
        },
      },
    });
    assert.equal(createRes.statusCode, 201);
    const created = createRes.json();
    assert.equal(
      validateTicket(created),
      true,
      `POST /Ticket divergiu do contrato: ${ajv.errorsText(validateTicket.errors)}`,
    );

    const updateRes = await app.inject({
      method: 'PUT',
      url: '/apirest.php/Ticket/42',
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
    assert.equal(
      validateTicket(updated),
      true,
      `PUT /Ticket/42 divergiu do contrato: ${ajv.errorsText(validateTicket.errors)}`,
    );

    assert.deepEqual(updated, openapiDoc.components.schemas.Ticket.example);

    const getRes = await app.inject({
      method: 'GET',
      url: '/apirest.php/Ticket/42',
      headers,
    });
    assert.equal(getRes.statusCode, 200);
    const fetched = getRes.json();
    assert.equal(
      validateTicket(fetched),
      true,
      `GET /Ticket/42 divergiu do contrato: ${ajv.errorsText(validateTicket.errors)}`,
    );

    const listRes = await app.inject({
      method: 'GET',
      url: '/apirest.php/Ticket?range=0-49',
      headers,
    });
    assert.equal(listRes.statusCode, 200);
    const listItems = listRes.json();
    assert.equal(listItems.length, 1);
    for (const item of listItems) {
      assert.equal(
        validateTicket(item),
        true,
        `Item de GET /Ticket divergiu do contrato: ${ajv.errorsText(validateTicket.errors)}`,
      );
    }

    const err401Res = await app.inject({
      method: 'GET',
      url: '/apirest.php/Ticket/42',
    });
    assert.equal(err401Res.statusCode, 401);
    assert.equal(
      validateGlpiError(err401Res.json()),
      true,
      `Erro 401 divergiu de GlpiError: ${ajv.errorsText(validateGlpiError.errors)}`,
    );

    const err403Res = await app.inject({
      method: 'PUT',
      url: '/apirest.php/Ticket/42',
      headers: estagiarioHeaders,
      payload: { input: { status: 3 } },
    });
    assert.equal(err403Res.statusCode, 403);
    assert.equal(
      validateGlpiError(err403Res.json()),
      true,
      `Erro 403 divergiu de GlpiError: ${ajv.errorsText(validateGlpiError.errors)}`,
    );

    const err404Res = await app.inject({
      method: 'GET',
      url: '/apirest.php/Ticket/999',
      headers,
    });
    assert.equal(err404Res.statusCode, 404);
    assert.equal(
      validateGlpiError(err404Res.json()),
      true,
      `Erro 404 divergiu de GlpiError: ${ajv.errorsText(validateGlpiError.errors)}`,
    );

    assert.equal(
      validateTicket({ ...updated, version: 1 }),
      false,
      'Schema Ticket não deve aceitar campo de versão ou propriedades extras',
    );
  } finally {
    await app.close();
  }
});

test('GET /health respeita o contrato (200 e 503)', async () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const responses = openapiDoc.paths['/health'].get.responses;
  const validate200 = ajv.compile(responses['200'].content['application/json'].schema);
  const validate503 = ajv.compile(responses['503'].content['application/json'].schema);

  const app = buildTestServer();
  try {
    const ok = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(ok.statusCode, 200);
    assert.equal(validate200(ok.json()), true, ajv.errorsText(validate200.errors));

    app.store.close();
    const down = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(down.statusCode, 503);
    assert.equal(validate503(down.json()), true, ajv.errorsText(validate503.errors));
  } finally {
    await app.close().catch(() => {});
  }
});

test('webhook ticket.changed respeita o schema do evento e os patterns de cabeçalho do OpenAPI', async () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const validateEvent = ajv.compile(eventSchema);

  const params = openapiDoc.webhooks['ticket.changed'].post.parameters;
  const sigPattern = new RegExp(
    params.find((p) => p.name === 'X-Signature-256').schema.pattern,
  );
  const tsPattern = new RegExp(params.find((p) => p.name === 'X-Timestamp').schema.pattern);

  const received = [];
  const receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        headers: req.headers,
        rawBody: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });

  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const { port } = receiver.address();

  const app = buildTestServer({
    timeZone: 'America/Sao_Paulo',
    now: () => Date.parse('2026-10-18T17:03:22Z'),
    webhook: {
      enabled: true,
      url: `http://127.0.0.1:${port}/webhooks/system-a`,
      secret: 'segredo-contrato-0123456789abcdef012345',
      dropRate: 0,
    },
  });

  try {
    const headers = await login(app, 'tecnico');
    const res = await app.inject({
      method: 'POST',
      url: '/apirest.php/Ticket',
      headers,
      payload: {
        input: {
          name: 'Chamado validado contra o contrato do webhook',
          content: 'Corpo do chamado',
        },
      },
    });
    assert.equal(res.statusCode, 201);
    await app.webhook.close();

    assert.equal(received.length, 1);
    assert.match(received[0].headers['x-signature-256'], sigPattern);
    assert.match(received[0].headers['x-timestamp'], tsPattern);

    const parsed = JSON.parse(received[0].rawBody);
    assert.equal(
      validateEvent(parsed),
      true,
      `Evento divergiu de ticket-changed.schema.json: ${ajv.errorsText(validateEvent.errors)}`,
    );
  } finally {
    await app.close();
    await new Promise((resolve) => receiver.close(resolve));
  }
});

test('resposta de getFullSession valida no schema do contrato', async () => {
  const { ajv } = createContractValidators();
  const validate = ajv.compile(
    openapiDoc.paths['/getFullSession'].get.responses['200'].content['application/json'].schema,
  );
  const app = buildTestServer();
  try {
    for (const profile of ['tecnico', 'estagiario', 'sync-bot']) {
      const headers = await login(app, profile);
      const res = await app.inject({ method: 'GET', url: '/apirest.php/getFullSession', headers });
      assert.equal(res.statusCode, 200);
      assert.equal(
        validate(res.json()),
        true,
        `GET /getFullSession (${profile}) divergiu do contrato: ${ajv.errorsText(validate.errors)}`,
      );
    }
  } finally {
    await app.close();
  }
});
