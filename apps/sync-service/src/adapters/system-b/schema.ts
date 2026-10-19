import { z } from 'zod';

// Espelho de contracts/system-b.openapi.yaml (o teste de contrato confere com o exemplo do arquivo).
// Objetos estritos, como o additionalProperties: false do contrato: campo renomeado ou a mais é drift.

const nullableString = z.string().nullable().optional();
const dateTime = z.iso.datetime({ offset: true });

const location = z.strictObject({
  name: nullableString,
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
});

const attachment = z.strictObject({
  name: z.string(),
  size: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const recordSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string(),
  state: z.enum(['OPEN', 'IN_PROGRESS', 'ON_HOLD', 'RESOLVED', 'CLOSED']),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  category: nullableString,
  requester: nullableString,
  assignee: nullableString,
  location: location.nullable().optional(),
  sourceUpdatedAt: dateTime.nullable().optional(),
  attachments: z.array(attachment).optional(),
  resolution: z.string().max(2000).nullable().optional(),
  updatedBy: nullableString,
  createdAt: dateTime.optional(),
  updatedAt: dateTime.optional(),
});

export const recordPageSchema = z.strictObject({
  items: z.array(recordSchema),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  total: z.number().int().min(0),
});

/** Corpo de erro do B. Num 2xx, é o "200 com erro" do caos (transitório), não drift. */
export const apiErrorSchema = z.object({ error: z.string(), message: z.string() });

/** Resumo curto do que não bateu, sem copiar o corpo (pode ter dado do chamado). */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
    .join('; ');
}
