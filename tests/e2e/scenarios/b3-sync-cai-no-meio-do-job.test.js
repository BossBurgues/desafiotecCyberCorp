// B3: o sync morre (SIGKILL) com jobs em andamento. O lease vence, outro processo retoma e nada é duplicado.
import { test } from 'node:test';
import { compose, expectSyncedOnce, setChaos, summary, tecnico, waitFor, waitReady } from '../lib.js';

test('B3: sync derrubado no meio do job → lease vence, reprocessa sem duplicar', async () => {
  await waitReady();
  // B lento: as escritas ficam em voo tempo bastante para o kill pegar o sync no meio delas
  await setChaos({ latencyMs: 3000 });
  const a = await tecnico();
  const expected = new Map();
  for (let i = 0; i < 4; i++) {
    const t = await a.create({ name: `B3 ${i}`, content: 'x' });
    expected.set(t.id, t.name);
  }
  await waitFor(async () => (await summary()).jobs.running > 0, { what: 'um job rodando', intervalMs: 200 });
  compose('kill', 'sync-service');
  compose('up', '-d', 'sync-service');
  await waitReady();
  await setChaos({});
  await expectSyncedOnce(expected, { timeoutMs: 120_000 });
});
