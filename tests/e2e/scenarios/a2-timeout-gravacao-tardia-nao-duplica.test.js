// A2: o B demora mais que o timeout do sync e grava depois. O sync desistiu, mas não recria às cegas.
import { test } from 'node:test';
import { expectSyncedOnce, recordsByTicket, setChaos, tecnico, waitFor, waitReady } from '../lib.js';

test('A2: timeout com gravação tardia → create ambíguo resolvido pelo marcador, um registro só', async () => {
  await waitReady();
  // 8 s de espera no B contra os 5 s de B_TIMEOUT_MS do sync: o sync desiste, o B grava depois
  await setChaos({ timeoutRate: 1, timeoutMs: 8000 });
  try {
    const a = await tecnico();
    const t = await a.create({ name: 'A2 gravação tardia', content: 'x' });
    await waitFor(async () => (await recordsByTicket()).has(t.id), { what: 'a gravação tardia no B' });
    await setChaos({});
    await expectSyncedOnce(new Map([[t.id, t.name]]));
  } finally {
    await setChaos({});
  }
});
