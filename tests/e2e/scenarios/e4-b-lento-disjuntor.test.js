// E4: o B fica lento (10 s por resposta, acima do timeout do sync). O disjuntor abre, nada se perde e tudo drena na volta.
import { test } from 'node:test';
import { expectSyncedOnce, setChaos, summary, tecnico, waitFor, waitReady } from '../lib.js';

test('E4: B lento → disjuntor abre; quando o B normaliza, todos sincronizam uma vez', async () => {
  await waitReady();
  await setChaos({ latencyMs: 10_000 });
  try {
    const a = await tecnico();
    const expected = new Map();
    for (let i = 0; i < 3; i++) {
      const t = await a.create({ name: `E4 B lento ${i}`, content: 'x' });
      expected.set(t.id, t.name);
    }
    await waitFor(async () => (await summary()).breaker === 'open', { timeoutMs: 120_000, what: 'o disjuntor abrir' });
    await setChaos({});
    await expectSyncedOnce(expected, { timeoutMs: 120_000 });
  } finally {
    await setChaos({});
  }
});
