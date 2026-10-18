import { describe, expect, it } from 'vitest';
import { AError, createSystemAClient } from '../../../src/adapters/system-a/client.js';
import { ticket } from '../../fakes.js';
import { memoryLogger } from '../../helpers.js';

type Handler = (url: URL, headers: Record<string, string>) => Response;

function client(handler: Handler) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = init?.headers as Record<string, string>;
    calls.push({ url, headers });
    return handler(url, headers);
  }) as typeof fetch;
  const a = createSystemAClient({
    baseUrl: 'http://a.test',
    appToken: 'app',
    userToken: 'bot',
    timeoutMs: 1000,
    logger: memoryLogger('silent').logger,
    fetch: fetchImpl,
  });
  return { a, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('client do A (sync-bot)', () => {
  it('abre a sessão com user_token e App-Token e reaproveita o session-token', async () => {
    const { a, calls } = client((url) =>
      url.pathname.endsWith('/initSession') ? json({ session_token: 's1' }) : json(ticket(1)),
    );
    await a.getTicket(1);
    await a.getTicket(1);
    expect(calls.map((c) => c.url.pathname)).toEqual(['/apirest.php/initSession', '/apirest.php/Ticket/1', '/apirest.php/Ticket/1']);
    expect(calls[0]!.headers).toMatchObject({ authorization: 'user_token bot', 'app-token': 'app' });
    expect(calls[1]!.headers).toMatchObject({ 'session-token': 's1', 'app-token': 'app' });
  });

  it('401 (sessão expirada) reabre a sessão uma vez e repete', async () => {
    let session = 0;
    const { a } = client((url, h) => {
      if (url.pathname.endsWith('/initSession')) return json({ session_token: `s${++session}` });
      return h['session-token'] === 's2' ? json(ticket(1)) : json(['ERROR_SESSION_TOKEN_INVALID', 'x'], 401);
    });
    expect((await a.getTicket(1))!.id).toBe(1);
    expect(session).toBe(2);
  });

  it('404 vira null; 5xx e corpo fora do formato viram AError transitório', async () => {
    let status = 404;
    let body: unknown = ['ERROR_ITEM_NOT_FOUND', 'x'];
    const { a } = client((url) => (url.pathname.endsWith('/initSession') ? json({ session_token: 's' }) : json(body, status)));
    expect(await a.getTicket(9)).toBeNull();
    status = 503;
    await expect(a.getTicket(9)).rejects.toBeInstanceOf(AError);
    status = 200;
    body = { id: 9 };
    await expect(a.getTicket(9)).rejects.toThrow('fora do formato');
  });

  it('falha ao abrir a sessão não fica em cache: a próxima chamada tenta de novo', async () => {
    let up = false;
    const { a } = client((url) => {
      if (url.pathname.endsWith('/initSession')) return up ? json({ session_token: 's' }) : json({}, 500);
      return json(ticket(1));
    });
    await expect(a.getTicket(1)).rejects.toThrow('initSession: 500');
    up = true;
    expect(await a.getTicket(1)).not.toBeNull();
  });

  it('rede fora do ar vira AError', async () => {
    const a = createSystemAClient({
      baseUrl: 'http://a.test',
      appToken: 'app',
      userToken: 'bot',
      timeoutMs: 1000,
      logger: memoryLogger('silent').logger,
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    await expect(a.getTicket(1)).rejects.toBeInstanceOf(AError);
  });

  it('listChangedSince pede date_mod_gte, range e ordem por date_mod; o total vem do Content-Range', async () => {
    const { a, calls } = client((url) =>
      url.pathname.endsWith('/initSession')
        ? json({ session_token: 's' })
        : json([ticket(1), ticket(2)], 206, { 'content-range': '0-1/5' }),
    );
    const page = await a.listChangedSince('2026-10-18 09:58:00', 0, 2);
    expect(page.total).toBe(5);
    expect(page.items.map((t) => t.id)).toEqual([1, 2]);
    const q = calls[1]!.url.searchParams;
    expect(Object.fromEntries(q)).toEqual({ date_mod_gte: '2026-10-18 09:58:00', range: '0-1', sort: 'date_mod', order: 'ASC' });
  });

  it('listChangedSince: 416 (página além do total) devolve vazio', async () => {
    const { a } = client((url) => (url.pathname.endsWith('/initSession') ? json({ session_token: 's' }) : json([], 416)));
    expect(await a.listChangedSince('2026-10-18 09:58:00', 10, 2)).toEqual({ items: [], total: 10 });
  });
});
