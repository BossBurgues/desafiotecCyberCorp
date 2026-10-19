// B1: o B fica fora (na CI, 30 s no lugar de 1 h). Os jobs esperam sem gastar tentativas, drenam na volta e nada
// vai para a DLQ.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SYNC_URL, compose, expectSyncedOnce, setChaos, sleep, summary, tecnico, waitFor, waitReady } from '../lib.js';

test('B1: B fora → jobs esperam, drenam quando o B volta, nenhum vai para a DLQ', async () => {
  await waitReady();
  await setChaos({});
  const a = await tecnico();
  const before = await a.create({ name: 'B1 antes da queda', content: 'x' });
  await expectSyncedOnce(new Map([[before.id, before.name]]));

  compose('stop', 'system-b');
  try {
    await waitFor(async () => (await fetch(`${SYNC_URL}/ready`)).status === 503, { what: 'sync ver o B fora' });
    const expected = new Map([[before.id, (await a.update(before.id, { name: 'B1 editado com o B fora' })).name]]);
    for (let i = 0; i < 5; i++) {
      const t = await a.create({ name: `B1 criado com o B fora ${i}`, content: 'x' });
      expected.set(t.id, t.name);
    }
    await sleep(30_000);
    const during = await summary();
    assert.equal(during.dlq.filter((j) => expected.has(j.ticket_id)).length, 0, 'nada na DLQ durante a queda');
    compose('start', 'system-b');
    await expectSyncedOnce(expected, { timeoutMs: 120_000 });
    const after = await summary();
    assert.equal(after.dlq.filter((j) => expected.has(j.ticket_id)).length, 0, 'nada na DLQ depois da volta');
  } finally {
    compose('start', 'system-b');
  }
});
