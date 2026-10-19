// B → A leve (opcional do avaliador): o operador do B fecha com solução → o A fica Fechado, com nota de quem alterou
// e da solução, e nada fica indo e voltando entre os sistemas (F1/F4).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { operatorUpdate, recordsByTicket, setChaos, sleep, tecnico, waitFor, waitReady } from '../lib.js';

test('F4: o B fecha com solução → o A fica Fechado com a nota; depois, nenhum lado recebe escrita extra', async () => {
  await waitReady();
  await setChaos({});
  const a = await tecnico();
  const t = await a.create({ name: 'F4 notebook sem rede', content: 'x' });
  const rec = await waitFor(async () => (await recordsByTicket()).get(t.id)?.[0], { what: 'o chamado no B' });

  await operatorUpdate(rec.id, { state: 'CLOSED', resolution: 'Driver reinstalado.' });
  const closed = await waitFor(async () => {
    const now = await a.get(t.id);
    return now.status === 6 ? now : null;
  }, { what: 'o A ficar Fechado', timeoutMs: 60_000 });

  const notes = await a.followups(t.id);
  assert.equal(notes.length, 1);
  assert.match(notes[0].content, /por Carla \(suporte\): Em andamento|por Carla \(suporte\): Aberto/);
  assert.match(notes[0].content, /Solução: Driver reinstalado\./);

  // Anti-eco: várias varreduras do B (a cada 2 s no E2E) e o poller do A depois da escrita do sync-bot
  const bBefore = (await recordsByTicket()).get(t.id)[0].updatedAt;
  await sleep(8_000);
  const after = (await recordsByTicket()).get(t.id);
  assert.equal(after.length, 1);
  assert.equal(after[0].updatedAt, bBefore, 'o B não recebeu nenhuma escrita depois do fechamento');
  assert.equal(after[0].state, 'CLOSED');
  assert.equal((await a.get(t.id)).date_mod, closed.date_mod, 'o A não recebeu nenhuma escrita depois do fechamento');
  assert.equal((await a.followups(t.id)).length, 1, 'uma nota só');
});
