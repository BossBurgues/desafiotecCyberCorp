// B6: 20 edições seguidas no mesmo chamado. Os jobs aglutinam (um por chamado) e o B termina na última versão.
import { test } from 'node:test';
import { expectSyncedOnce, setChaos, tecnico, waitReady } from '../lib.js';

test('B6: 20 updates em sequência rápida → o B termina com o 20º título, sem duplicar', async () => {
  await waitReady();
  // B um pouco lento: as edições chegam enquanto o job anterior ainda está escrevendo
  await setChaos({ latencyMs: 300 });
  try {
    const a = await tecnico();
    const t = await a.create({ name: 'B6 versão 0', content: 'x' });
    let last;
    for (let i = 1; i <= 20; i++) last = await a.update(t.id, { name: `B6 versão ${i}` });
    await expectSyncedOnce(new Map([[t.id, last.name]]));
  } finally {
    await setChaos({});
  }
});
