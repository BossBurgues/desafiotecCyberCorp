// Exclusão nos dois lados (ADR-015): excluir no A apaga no B e restaurar recria; excluir no B leva o chamado para a
// lixeira do A, com nota de quem excluiu. Reproduz o bug de 19/10 (excluir no B não chegava ao A).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { operatorDelete, recordsByTicket, setChaos, sleep, tecnico, tombstoneOf, waitFor, waitReady } from '../lib.js';

test('H1: excluir no A apaga no B (lápide do sync); restaurar recria, sem duplicar', async () => {
  await waitReady();
  await setChaos({});
  const a = await tecnico();
  const t = await a.create({ name: 'H1 impressora antiga', content: 'x' });
  const rec = await waitFor(async () => (await recordsByTicket()).get(t.id)?.[0], { what: 'o chamado no B' });

  await a.remove(t.id);
  const tomb = await waitFor(() => tombstoneOf(rec.id), { what: 'o registro excluído no B' });
  assert.equal(tomb.deletedBy, 'integração (sync)');
  assert.equal((await recordsByTicket()).get(t.id), undefined);

  await a.update(t.id, { is_deleted: 0 });
  const back = await waitFor(async () => (await recordsByTicket()).get(t.id), { what: 'o registro recriado' });
  assert.equal(back.length, 1);
  assert.notEqual(back[0].id, rec.id);
});

test('H1: o operador exclui no B → o chamado vai para a lixeira do A com nota; nada volta para o B', async () => {
  await waitReady();
  await setChaos({});
  const a = await tecnico();
  const t = await a.create({ name: 'H1 ramal mudo', content: 'x' });
  const rec = await waitFor(async () => (await recordsByTicket()).get(t.id)?.[0], { what: 'o chamado no B' });

  await operatorDelete(rec.id, 'Maria');
  // O sync manda para a lixeira e depois grava a nota (duas escritas no A): espera as duas
  const trashed = await waitFor(async () => {
    const now = await a.get(t.id);
    return now.is_deleted === 1 && (await a.followups(t.id)).length > 0 ? now : null;
  }, { what: 'o chamado na lixeira do A, com a nota' });

  const notes = await a.followups(t.id);
  assert.equal(notes.length, 1);
  assert.match(notes[0].content, /Excluído no Sistema B por Maria/);

  // Sem eco: varreduras e poller seguintes não recriam o registro nem mexem no A
  await sleep(8_000);
  assert.equal((await recordsByTicket()).get(t.id), undefined);
  assert.equal((await a.get(t.id)).date_mod, trashed.date_mod);
  assert.equal((await a.followups(t.id)).length, 1);
});
