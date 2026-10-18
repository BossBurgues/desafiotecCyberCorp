import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TEST_AUTH_CONFIG } from '../helpers/session.js';

const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/server.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port, child, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`servidor saiu antes de ficar saudável (código ${child.exitCode})`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.status === 200) return;
    } catch {
      // ainda subindo
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('servidor não respondeu /health a tempo');
}

// No Windows, SIGTERM mata o processo sem chamar o handler; a CI (Linux) é a fonte da verdade.
test(
  'SIGTERM fecha o servidor e sai com código 0 em menos de 5 s',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-a-shutdown-'));
    const port = await freePort();
    const child = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        PORT: String(port),
        A_DB_PATH: path.join(dir, 'a.db'),
        A_APP_TOKEN: TEST_AUTH_CONFIG.appToken,
        A_TECNICO_PASSWORD: TEST_AUTH_CONFIG.tecnicoPassword,
        A_ESTAGIARIO_PASSWORD: TEST_AUTH_CONFIG.estagiarioPassword,
        A_SYNC_BOT_TOKEN: TEST_AUTH_CONFIG.syncBotToken,
      },
      stdio: 'ignore',
    });
    try {
      await waitForHealth(port, child);
      const started = Date.now();
      const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
      child.kill('SIGTERM');
      const { code, signal } = await exit;
      assert.equal(signal, null);
      assert.equal(code, 0);
      assert.ok(Date.now() - started < 5000, 'encerramento demorou mais de 5 s');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
