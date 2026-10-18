import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import YAML from 'yaml';
import { buildServer } from '../../src/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractPath = path.resolve(__dirname, '../../../../contracts/system-a.openapi.yaml');
const openapiDoc = YAML.parse(fs.readFileSync(contractPath, 'utf8'));

function createContractValidators() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(openapiDoc, 'openapi');

  const validateTicket = ajv.getSchema('openapi#/components/schemas/Ticket');
  const validateGlpiError = ajv.getSchema('openapi#/components/schemas/GlpiError');
  assert.ok(validateTicket, 'Schema Ticket deve existir em contracts/system-a.openapi.yaml');
  assert.ok(validateGlpiError, 'Schema GlpiError deve existir em contracts/system-a.openapi.yaml');

  return { ajv, validateTicket, validateGlpiError };
}

test('respostas de POST, GET, PUT e listagem respeitam o schema Ticket de contracts/system-a.openapi.yaml', async () => {
  const { ajv, validateTicket, validateGlpiError } = createContractValidators();

  const instants = [
    Date.parse('2026-10-18T16:50:00Z'), // 2026-10-18 13:50:00 em America/Sao_Paulo
    Date.parse('2026-10-18T17:03:22Z'), // 2026-10-18 14:03:22 em America/Sao_Paulo
  ];
  let idx = 0;

  const app = buildServer({
    dbPath: ':memory:',
    timeZone: 'America/Sao_Paulo',
    now: () => instants[Math.min(idx++, instants.length - 1)],
  });

  try {
    // Reserva IDs 1..41 no SQLite para que o próximo chamado criado pela API receba id 42 (mesmo exemplo do contrato e de S3.2).
    app.store.db.exec("INSERT INTO sqlite_sequence (name, seq) VALUES ('tickets', 41)");

    const createRes = await app.inject({
      method: 'POST',
      url: '/apirest.php/Ticket',
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

    const errRes = await app.inject({
      method: 'GET',
      url: '/apirest.php/Ticket/999',
    });
    assert.equal(errRes.statusCode, 404);
    assert.equal(
      validateGlpiError(errRes.json()),
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
