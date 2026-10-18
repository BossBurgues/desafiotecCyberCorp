import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { createLogger } from '../src/infra/logger.js';

/** Logger que guarda cada linha JSON em memória, para os testes lerem o que foi logado. */
export function memoryLogger(level = 'info') {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      for (const line of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(line));
      done();
    },
  });
  return { logger: createLogger(level, stream), lines };
}

/** Servidor HTTP de mentira para /health do A ou do B. */
export async function fakeHealthServer(
  handler: (res: import('node:http').ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => handler(res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
