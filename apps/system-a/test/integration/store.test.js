import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TicketStore } from '../../src/store.js';

test('persiste chamado em arquivo SQLite após fechar e reabrir o banco', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-a-store-'));
  const dbPath = path.join(tmpDir, 'tickets.db');

  try {
    const store1 = new TicketStore(dbPath);
    const created = store1.insert({
      name: 'Impressora do 3º andar não imprime',
      content: '<p>Parou após queda de energia.</p>',
      status: 2,
      priority: 4,
      itilcategories_id: 3,
      locations_id: 1,
      users_id_recipient: 2,
      users_id_assign: 1,
      date: '2026-10-18 13:50:00',
      date_mod: '2026-10-18 14:03:22',
      solvedate: null,
      closedate: null,
    });
    store1.close();

    assert.equal(created.id, 1);

    const store2 = new TicketStore(dbPath);
    const loaded = store2.getById(1);
    const total = store2.count();
    store2.close();

    assert.equal(total, 1);
    assert.deepEqual(loaded, {
      id: 1,
      name: 'Impressora do 3º andar não imprime',
      content: '<p>Parou após queda de energia.</p>',
      status: 2,
      priority: 4,
      itilcategories_id: 3,
      locations_id: 1,
      users_id_recipient: 2,
      users_id_assign: 1,
      date: '2026-10-18 13:50:00',
      date_mod: '2026-10-18 14:03:22',
      solvedate: null,
      closedate: null,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
