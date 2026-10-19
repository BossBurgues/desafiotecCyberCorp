import { describe, expect, it } from 'vitest';
import { AError, createSystemAClient } from '../../../src/adapters/system-a/client.js';
import { ticket } from '../../fakes.js';
import { memoryLogger } from '../../helpers.js';

type Handler = (url: URL, headers: Record<string, string>) => Response;

function client(handler: Handler) {
  const calls: { url: URL; headers: Record<string, string>; method: string }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = init?.headers as Record<string, string>;
    calls.push({ url, headers, method: init?.method ?? 'GET' });
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
    expect(Object.fromEntries(q)).toEqual({ date_mod_gte: '2026-10-18 09:58:00', range: '0-1', sort: 'date_mod', order: 'ASC', is_deleted: '0' });
    await a.listChangedSince('2026-10-18 09:58:00', 0, 2, true);
    expect(calls[2]!.url.searchParams.get('is_deleted')).toBe('1');
  });

  it('trashTicket manda DELETE /Ticket/:id (lixeira do A); 404 devolve false', async () => {
    const { a, calls } = client((url) =>
      url.pathname.endsWith('/initSession') ? json({ session_token: 's' }) : url.pathname.endsWith('/7') ? json([{ 7: true, message: '' }]) : json(['ERROR_ITEM_NOT_FOUND', 'x'], 404),
    );
    expect(await a.trashTicket(7)).toBe(true);
    expect(calls[1]!.method).toBe('DELETE');
    expect(await a.trashTicket(8)).toBe(false);
  });

  it('listChangedSince: 416 (página além do total) devolve vazio', async () => {
    const { a } = client((url) => (url.pathname.endsWith('/initSession') ? json({ session_token: 's' }) : json([], 416)));
    expect(await a.listChangedSince('2026-10-18 09:58:00', 10, 2)).toEqual({ items: [], total: 10 });
  });
  it('catálogos do GLPI viram o formato do B: categoria com o caminho, usuário com nome e login, local com coordenadas', async () => {
    const { a } = client((url) => {
      if (url.pathname.endsWith('/initSession')) return json({ session_token: 's1' });
      if (url.pathname.endsWith('/ITILCategory')) return json([{ id: 2, name: 'Impressão', completename: 'Hardware > Impressão' }]);
      if (url.pathname.endsWith('/User')) {
        return json([
          { id: 1, name: 'tecnico', firstname: 'Ana', realname: 'Souza', profile: 'tecnico' },
          { id: 3, name: 'sync-bot', firstname: '', realname: '', profile: 'sync-bot' },
        ]);
      }
      return json([
        { id: 1, name: 'Matriz · 3º andar', completename: 'Matriz > 3º andar', latitude: -23.5, longitude: -46.6 },
        { id: 4, name: 'Home office', completename: 'Home office', latitude: null, longitude: null },
      ]);
    });
    const l = await a.getLookups();
    expect((l.categories as Map<number, string>).get(2)).toBe('Hardware > Impressão');
    expect((l.users as Map<number, string>).get(1)).toBe('Ana Souza (tecnico)');
    expect((l.users as Map<number, string>).get(3)).toBe('sync-bot');
    expect((l.locations as Map<number, unknown>).get(1)).toEqual({ name: 'Matriz · 3º andar', lat: -23.5, lng: -46.6 });
    expect((l.locations as Map<number, unknown>).get(4)).toEqual({ name: 'Home office', lat: null, lng: null });
  });

  it('A sem os catálogos (404) devolve tabelas vazias; 5xx é AError transitório', async () => {
    const empty = client((url) => (url.pathname.endsWith('/initSession') ? json({ session_token: 's1' }) : json(['ERROR_ITEM_NOT_FOUND', 'x'], 404)));
    const l = await empty.a.getLookups();
    expect((l.users as Map<number, string>).size).toBe(0);
    const down = client((url) => (url.pathname.endsWith('/initSession') ? json({ session_token: 's1' }) : json({}, 503)));
    await expect(down.a.getLookups()).rejects.toBeInstanceOf(AError);
  });
});
