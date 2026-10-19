// A1: o B grava e responde 500 (commit-then-fail). O create é ambíguo: o sync procura o marcador e adota, sem recriar.
import { test } from 'node:test';
import { expectSyncedOnce, recordsByTicket, setChaos, tecnico, waitFor, waitReady } from '../lib.js';

test('A1: commit-then-fail no create → o retry acha o marcador e adota, um registro só', async () => {
  await waitReady();
  await setChaos({ commitThenFailRate: 1 });
  try {
    const a = await tecnico();
    const t = await a.create({ name: 'A1 commit-then-fail', content: 'x' });
    // O B gravou (a rota do operador fica fora do caos) mesmo tendo respondido 500 ao sync
    await waitFor(async () => (await recordsByTicket()).has(t.id), { what: 'o B gravar apesar do 500' });
    await setChaos({});
    await expectSyncedOnce(new Map([[t.id, t.name]]));
  } finally {
    await setChaos({});
  }
});
