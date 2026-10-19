import type { Logger } from 'pino';
import { z } from 'zod';
import type { GlpiTicket, Lookups, RecordLocation } from '../../domain/types.js';

const API_PREFIX = '/apirest.php';

const glpiDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
const optionalId = z.number().int().nullable().optional();

// Só os campos que o sync usa; o A pode devolver outros (é o GLPI, não um contrato estrito como o do B)
export const ticketSchema = z.object({
  id: z.number().int().min(1),
  name: z.string(),
  content: z.string(),
  status: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
  itilcategories_id: optionalId,
  locations_id: optionalId,
  users_id_recipient: optionalId,
  users_id_assign: optionalId,
  date: glpiDateTime,
  date_mod: glpiDateTime,
  solvedate: glpiDateTime.nullable().optional(),
  closedate: glpiDateTime.nullable().optional(),
  attachments: z
    .array(z.object({ name: z.string(), size: z.number().int().min(0), sha256: z.string() }))
    .optional(),
});

const categorySchema = z.object({ id: z.number().int(), name: z.string(), completename: z.string().optional() });
const locationSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
});
const userSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  firstname: z.string().optional(),
  realname: z.string().optional(),
});

/** "Ana Souza (tecnico)": o nome que o B mostra para requerente e técnico (docs/field-mapping.md). */
export function userDisplayName(user: z.infer<typeof userSchema>): string {
  const full = [user.firstname, user.realname].filter(Boolean).join(' ');
  return full ? `${full} (${user.name})` : user.name;
}

/** Falha ao falar com o A. Sempre transitória: o A é a fonte da verdade e está sob o nosso controle. */
export class AError extends Error {
  public readonly errorClass = 'transient' as const;
  public readonly status: number | undefined;

  constructor(message: string, status?: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AError';
    this.status = status;
  }
}

export interface TicketPage {
  items: GlpiTicket[];
  /** Total de chamados que batem com o filtro (do Content-Range). */
  total: number;
}

export interface SystemAClient {
  /** null = 404: o chamado não existe (mais) no A. */
  getTicket(id: number): Promise<GlpiTicket | null>;
  /** Chamados com date_mod >= `dateModGteLocal` (no fuso do A), em ordem de date_mod. */
  listChangedSince(dateModGteLocal: string, start: number, limit: number): Promise<TicketPage>;
  /** Catálogos do GLPI (categorias, usuários e locais) já no formato do B, para o mapper converter os IDs. */
  getLookups(): Promise<Lookups>;
  /** B → A leve: o sync-bot muda só o status (o A recusa qualquer outro campo vindo dele). null = chamado sumiu. */
  updateStatus(id: number, status: GlpiTicket['status']): Promise<GlpiTicket | null>;
  /** B → A leve: nota na conversa do chamado, como sync-bot. */
  addFollowup(id: number, content: string): Promise<void>;
}

export interface SystemAClientOptions {
  baseUrl: string;
  appToken: string;
  userToken: string;
  timeoutMs: number;
  logger: Logger;
  fetch?: typeof fetch;
}

/**
 * Cliente do A (S3.6). O sync entra como sync-bot com user_token: a sessão é aberta sob demanda e reaberta uma vez
 * se o A responder 401 (sessão expirada ou A reiniciado). O worker sempre lê o estado atual do A por aqui, nunca o
 * payload do evento (ADR-005).
 */
export function createSystemAClient(options: SystemAClientOptions): SystemAClient {
  const doFetch = options.fetch ?? fetch;
  const log = options.logger.child({ component: 'system-a-client' });
  let session: Promise<string> | null = null;

  async function request(path: string, headers: Record<string, string>, method = 'GET', body?: unknown): Promise<Response> {
    try {
      return await doFetch(`${options.baseUrl}${API_PREFIX}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          'app-token': options.appToken,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (err) {
      throw new AError(`${method} ${API_PREFIX}${path}: ${err instanceof Error ? err.message : String(err)}`, undefined, err);
    }
  }

  async function openSession(): Promise<string> {
    const res = await request('/initSession', { authorization: `user_token ${options.userToken}` });
    if (!res.ok) throw new AError(`initSession: ${res.status}`, res.status);
    const body = (await res.json()) as { session_token?: unknown };
    if (typeof body.session_token !== 'string') throw new AError('initSession: resposta sem session_token');
    log.debug('sessão do sync-bot aberta no A');
    return body.session_token;
  }

  async function authed(path: string, method = 'GET', body?: unknown): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      session ??= openSession().catch((err: unknown) => {
        session = null;
        throw err;
      });
      const token = await session;
      const res = await request(path, { 'session-token': token }, method, body);
      if (res.status !== 401 || attempt > 0) return res;
      session = null;
    }
  }

  async function json(res: Response, path: string): Promise<unknown> {
    try {
      return await res.json();
    } catch (err) {
      throw new AError(`GET ${API_PREFIX}${path}: ${res.status} com corpo que não é JSON`, res.status, err);
    }
  }

  return {
    async getTicket(id) {
      const path = `/Ticket/${id}`;
      const res = await authed(path);
      if (res.status === 404) return null;
      if (!res.ok) throw new AError(`GET ${API_PREFIX}${path}: ${res.status}`, res.status);
      const parsed = ticketSchema.safeParse(await json(res, path));
      if (!parsed.success) throw new AError(`GET ${API_PREFIX}${path}: chamado fora do formato esperado`);
      return parsed.data as GlpiTicket;
    },

    async listChangedSince(dateModGteLocal, start, limit) {
      const query = new URLSearchParams({
        date_mod_gte: dateModGteLocal,
        range: `${start}-${start + limit - 1}`,
        sort: 'date_mod',
        order: 'ASC',
      });
      const path = `/Ticket?${query.toString()}`;
      const res = await authed(path);
      // 416: o início da página passou do total (a lista encolheu entre duas páginas)
      if (res.status === 416) return { items: [], total: start };
      if (!res.ok) throw new AError(`GET ${API_PREFIX}/Ticket: ${res.status}`, res.status);
      const parsed = z.array(ticketSchema).safeParse(await json(res, path));
      if (!parsed.success) throw new AError(`GET ${API_PREFIX}/Ticket: lista fora do formato esperado`);
      const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1] ?? start + parsed.data.length);
      return { items: parsed.data as GlpiTicket[], total };
    },

    async updateStatus(id, status) {
      const path = `/Ticket/${id}`;
      const res = await authed(path, 'PUT', { input: { status } });
      if (res.status === 404) return null;
      if (!res.ok) throw new AError(`PUT ${API_PREFIX}${path}: ${res.status}`, res.status);
      const parsed = ticketSchema.safeParse(await json(res, path));
      if (!parsed.success) throw new AError(`PUT ${API_PREFIX}${path}: chamado fora do formato esperado`);
      return parsed.data as GlpiTicket;
    },

    async addFollowup(id, content) {
      const res = await authed('/ITILFollowup', 'POST', { input: { itemtype: 'Ticket', items_id: id, content } });
      if (!res.ok) throw new AError(`POST ${API_PREFIX}/ITILFollowup: ${res.status}`, res.status);
    },

    async getLookups() {
      const load = async <T>(path: string, schema: z.ZodType<T>): Promise<T[]> => {
        const res = await authed(path);
        // A sem o catálogo (versão antiga): o campo vai vazio para o B, como antes
        if (res.status === 404) return [];
        if (!res.ok) throw new AError(`GET ${API_PREFIX}${path}: ${res.status}`, res.status);
        const parsed = z.array(schema).safeParse(await json(res, path));
        if (!parsed.success) throw new AError(`GET ${API_PREFIX}${path}: catálogo fora do formato esperado`);
        return parsed.data;
      };
      const [categories, users, locations] = await Promise.all([
        load('/ITILCategory', categorySchema),
        load('/User', userSchema),
        load('/Location', locationSchema),
      ]);
      return {
        categories: new Map(categories.map((c) => [c.id, c.completename ?? c.name])),
        users: new Map(users.map((u) => [u.id, userDisplayName(u)])),
        locations: new Map(
          locations.map((l): [number, RecordLocation] => [l.id, { name: l.name, lat: l.latitude ?? null, lng: l.longitude ?? null }]),
        ),
      };
    },
  };
}
