// C1: um evento velho chega depois do novo. O evento é só um sinal (ADR-005): o sync relê o A e o B fica no mais novo.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectSyncedOnce, recordsByTicket, sendWebhook, setChaos, tecnico, waitQueueIdle, waitReady } from '../lib.js';

test('C1: reentregar o evento da versão 1 depois da versão 2 não volta o B para a versão 1', async () => {
  await waitReady();
  await setChaos({});
  const a = await tecnico();
  const t = await a.create({ name: 'C1 versão 0', content: 'x' });
  const v1 = await a.update(t.id, { name: 'C1 versão 1' });
  const v2 = await a.update(t.id, { name: 'C1 versão 2' });
  await expectSyncedOnce(new Map([[t.id, v2.name]]));

  // Os eventos antigos chegam atrasados (o de criação e o da versão 1), fora de ordem
  await sendWebhook(t.id, { action: 'updated', dateMod: v1.date_mod });
  await sendWebhook(t.id, { action: 'created', dateMod: t.date_mod });
  await waitQueueIdle();

  const recs = (await recordsByTicket()).get(t.id);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].title, v2.name);
});
