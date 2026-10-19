// Núcleo A→B com o caos agressivo ligado: tudo o que o A cria e edita chega ao B uma vez, atualizado.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGGRESSIVE_CHAOS, expectSyncedOnce, setChaos, summary, tecnico, waitReady } from '../lib.js';

test('20 chamados criados e 5 editados sob caos chegam ao B uma vez cada, com a última versão', async () => {
  await waitReady();
  await setChaos(AGGRESSIVE_CHAOS);
  const a = await tecnico();
  const expected = new Map();
  for (let i = 0; i < 20; i++) {
    const t = await a.create({ name: `Núcleo ${i} — ação ✓`, content: '<p>caos <b>ligado</b></p>', priority: (i % 5) + 1 });
    expected.set(t.id, t.name);
  }
  for (const id of [...expected.keys()].slice(0, 5)) {
    const t = await a.update(id, { name: `Núcleo ${id} editado` });
    expected.set(id, t.name);
  }
  await expectSyncedOnce(expected, { timeoutMs: 120_000 });
  const s = await summary();
  assert.equal(s.dlq.filter((j) => expected.has(j.ticket_id)).length, 0, 'nenhum desses chamados foi para a DLQ');
});
