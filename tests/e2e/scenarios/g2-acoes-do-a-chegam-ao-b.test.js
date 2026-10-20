// O A é a tela de trabalho (GLPI): as ações que a UI do A faz (atribuir, solucionar, fechar, reabrir) pelo mesmo
// caminho da API chegam ao B, num registro só.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordsByTicket, setChaos, tecnico, waitFor, waitReady } from '../lib.js';

test('G2: atribuir → solucionar → fechar → reabrir no A aparece no B, sempre no mesmo registro', async () => {
  await waitReady();
  await setChaos({});
  const a = await tecnico();
  const t = await a.create({ name: 'G2 monitor piscando', content: 'x' });
  const recordState = (state, extra = () => true) =>
    waitFor(async () => {
      const recs = (await recordsByTicket()).get(t.id) ?? [];
      return recs.length === 1 && recs[0].state === state && extra(recs[0]) ? recs[0] : null;
    }, { what: `o B em ${state}` });

  await recordState('OPEN');
  // "Atribuir a mim": técnico 1 e, como estava Novo, Em atendimento
  await a.update(t.id, { users_id_assign: 1, status: 2 });
  const assigned = await recordState('IN_PROGRESS', (r) => Boolean(r.assignee));
  assert.match(assigned.assignee, /tecnico/);

  // "Solucionar": a nota da solução fica no A; o status vai ao B
  await a.note(t.id, 'Solução: cabo trocado.');
  await a.update(t.id, { status: 5 });
  await recordState('RESOLVED');
  await a.update(t.id, { status: 6 });
  await recordState('CLOSED');
  await a.update(t.id, { status: 2 });
  const reopened = await recordState('IN_PROGRESS');

  assert.equal(reopened.id, assigned.id, 'o mesmo registro do começo ao fim');
  const now = await a.get(t.id);
  assert.equal(now.solvedate, null, 'reabrir limpa a data de solução, como no GLPI');
  assert.equal(now.closedate, null);
});
