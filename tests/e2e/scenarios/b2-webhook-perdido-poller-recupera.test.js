// B2: o A perde 100% dos webhooks. O poller (com sobreposição) é a garantia: nada se perde.
import { after, before, test } from 'node:test';
import { compose, composeWith, expectSyncedOnce, setChaos, tecnico, waitReady } from '../lib.js';

const NO_WEBHOOK = ['infra/docker-compose.e2e.nowebhook.yml'];

before(() => {
  // Recria só o A sem webhook; os dados ficam no volume do E2E
  composeWith(NO_WEBHOOK, 'up', '-d', '--wait', 'system-a');
});
after(() => {
  compose('up', '-d', '--wait', 'system-a');
});

test('B2: sem nenhum webhook, criações e edições chegam ao B pelo poller', async () => {
  await waitReady();
  await setChaos({});
  const a = await tecnico();
  const expected = new Map();
  for (let i = 0; i < 3; i++) {
    const t = await a.create({ name: `B2 sem webhook ${i}`, content: 'x' });
    expected.set(t.id, t.name);
  }
  const first = [...expected.keys()][0];
  expected.set(first, (await a.update(first, { name: 'B2 editado sem webhook' })).name);
  await expectSyncedOnce(expected);
});
