// Conversão de campos (o PDF deixa por nossa conta): o chamado do A (GLPI, com IDs de categoria, local e usuários)
// chega ao B no formato dele, com os nomes; solucionar e fechar no A viram RESOLVED e CLOSED no B.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordsByTicket, setChaos, tecnico, waitFor, waitReady } from '../lib.js';

test('G1: categoria, local, requerente e técnico viram texto no B; solucionar e fechar chegam como RESOLVED e CLOSED', async () => {
  await waitReady();
  await setChaos({});
  const a = await tecnico();
  const t = await a.create({
    name: 'G1 impressora do 3º andar',
    content: '<p>Sem toner</p>',
    priority: 4,
    itilcategories_id: 2,
    locations_id: 1,
    users_id_assign: 1,
  });

  const rec = await waitFor(async () => (await recordsByTicket()).get(t.id)?.[0], { what: 'o chamado no B' });
  assert.equal(rec.title, 'G1 impressora do 3º andar');
  assert.equal(rec.severity, 'HIGH');
  assert.equal(rec.category, 'Hardware > Impressão');
  assert.equal(rec.requester, 'Ana Souza (tecnico)');
  assert.equal(rec.assignee, 'Ana Souza (tecnico)');
  assert.equal(rec.location.name, 'Matriz · 3º andar');
  assert.equal(typeof rec.location.lat, 'number');

  for (const [status, state] of [[5, 'RESOLVED'], [6, 'CLOSED']]) {
    await a.update(t.id, { status });
    await waitFor(async () => (await recordsByTicket()).get(t.id)?.[0]?.state === state, { what: `o B em ${state}` });
  }
  assert.equal((await recordsByTicket()).get(t.id).length, 1);
});
