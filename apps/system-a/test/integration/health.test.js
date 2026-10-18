import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTestServer } from '../helpers/session.js';

test('GET /health responde 200 sem App-Token nem Session-Token', async () => {
  const app = buildTestServer();
  try {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: 'ok' });
  } finally {
    await app.close();
  }
});

test('GET /health responde 503 quando o banco está fechado', async () => {
  const app = buildTestServer();
  try {
    app.store.close();
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { status: 'error' });
  } finally {
    await app.close().catch(() => {});
  }
});

test('GET /health não grava em access_denials', async () => {
  const app = buildTestServer();
  try {
    await app.inject({ method: 'GET', url: '/health' });
    assert.equal(app.store.listDenials().length, 0);
  } finally {
    await app.close();
  }
});

test('rotas de /apirest.php continuam exigindo token mesmo com /health aberto', async () => {
  const app = buildTestServer();
  try {
    const res = await app.inject({ method: 'GET', url: '/apirest.php/Ticket' });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
  }
});
