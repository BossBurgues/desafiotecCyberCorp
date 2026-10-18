import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { mapTicketToRecord } from '../../../src/domain/mapper.js';
import type { GlpiTicket } from '../../../src/domain/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../../..');

function loadOpenApiComponents(contractFile: string): Record<string, unknown> {
  const raw = readFileSync(resolve(REPO_ROOT, 'contracts', contractFile), 'utf8');
  const parsed = parseYaml(raw) as { components: { schemas: Record<string, unknown> } };
  return parsed.components.schemas;
}

function createSchemaValidator(
  schemas: Record<string, unknown>,
  schemaName: string,
  docId: string,
) {
  const ajv = new Ajv2020.default({
    strict: false,
    allErrors: true,
  });
  addFormats.default(ajv);
  ajv.addSchema(
    {
      $id: docId,
      components: { schemas },
    },
    docId,
  );
  const validate = ajv.getSchema(`${docId}#/components/schemas/${schemaName}`);
  if (!validate) {
    throw new Error(`Schema ${schemaName} não encontrado em ${docId}`);
  }
  return validate;
}

describe('contrato OpenAPI × mapper (S0.4, S3.2)', () => {
  const schemasA = loadOpenApiComponents('system-a.openapi.yaml');
  const schemasB = loadOpenApiComponents('system-b.openapi.yaml');
  const validateTicketA = createSchemaValidator(schemasA, 'Ticket', 'https://cybercorp.local/a.yaml');
  const validateRecordInputB = createSchemaValidator(
    schemasB,
    'RecordInput',
    'https://cybercorp.local/b.yaml',
  );

  const ticketExampleFromContractA = (schemasA['Ticket'] as { example: GlpiTicket }).example;

  it('fixture do contrato do A é válido contra components.schemas.Ticket', () => {
    const valid = validateTicketA(ticketExampleFromContractA);
    expect(validateTicketA.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it('saída do mapper valida contra components.schemas.RecordInput em todos os casos de borda', () => {
    const recordFromExample = mapTicketToRecord(ticketExampleFromContractA, {
      timeZone: 'America/Sao_Paulo',
      lookups: {
        categories: { 3: 'Hardware > Impressoras' },
        users: { 1: 'tecnico@cybercorp.local', 2: 'maria@cybercorp.local' },
        locations: { 1: { name: 'Matriz - 3º andar', lat: -23.5505, lng: -46.6333 } },
      },
    });
    expect(validateRecordInputB(recordFromExample)).toBe(true);

    const recordAllNulls = mapTicketToRecord(
      {
        id: 1,
        name: 'Chamado mínimo',
        content: '',
        status: 1,
        priority: 1,
        itilcategories_id: null,
        locations_id: null,
        users_id_recipient: null,
        users_id_assign: null,
        date: '2026-10-18 10:00:00',
        date_mod: '2026-10-18 10:00:00',
        solvedate: null,
        closedate: null,
      },
      { timeZone: 'America/Sao_Paulo' },
    );
    expect(validateRecordInputB(recordAllNulls)).toBe(true);

    const recordLongEmojiTitle = mapTicketToRecord(
      {
        ...ticketExampleFromContractA,
        name: `${'🔥'.repeat(120)}_${'A'.repeat(130)}`,
      },
      { timeZone: 'America/Sao_Paulo', markerField: 'title' },
    );
    expect(validateRecordInputB(recordLongEmojiTitle)).toBe(true);

    const recordBigHtml = mapTicketToRecord(
      {
        ...ticketExampleFromContractA,
        content: '<p>Bloco de 100 KB com <b>HTML</b> &amp; acentuação</p>\n'.repeat(2000),
      },
      { timeZone: 'America/Sao_Paulo' },
    );
    expect(validateRecordInputB(recordBigHtml)).toBe(true);
  });
});
