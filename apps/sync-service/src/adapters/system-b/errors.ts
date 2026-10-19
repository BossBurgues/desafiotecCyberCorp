/** Transitório = "o B está fora ou instável, tente de novo"; permanente = "o B recusou, repetir não muda nada" (ADR-008). */
export type ErrorClass = 'transient' | 'permanent';

export type BErrorReason =
  | 'timeout' // sem resposta em B_TIMEOUT_MS
  | 'network' // conexão recusada, resetada, DNS
  | 'rate_limited' // 429
  | 'server_error' // 5xx
  | 'error_body' // 2xx com corpo { error, message }
  | 'invalid_body' // 2xx que nem é JSON
  | 'circuit_open' // disjuntor aberto: a requisição nem saiu
  | 'precondition_failed' // 412 com If-Match: o registro mudou no B, reler e tentar de novo
  | 'rejected' // 400/422 e demais 4xx
  | 'not_found' // 404
  | 'schema_drift'; // 2xx com JSON fora do contrato (campo renomeado, tipo trocado)

const TRANSIENT: ReadonlySet<BErrorReason> = new Set([
  'timeout',
  'network',
  'rate_limited',
  'server_error',
  'error_body',
  'invalid_body',
  'circuit_open',
  'precondition_failed',
]);

/**
 * Falhas em que o B pode ter gravado mesmo assim (timeout com gravação tardia, grava e devolve 500, 200 com erro).
 * Num create, o resultado é ambíguo: nunca reenviar às cegas, procurar o marcador (ADR-004).
 * O drift também: o 2xx diz que o B aceitou a escrita, só o corpo da resposta mudou de formato. Reenviar o create
 * a cada tentativa criaria um registro novo por tentativa.
 */
const MAYBE_WRITTEN: ReadonlySet<BErrorReason> = new Set([
  'timeout',
  'network',
  'server_error',
  'error_body',
  'invalid_body',
  'schema_drift',
]);

export class BError extends Error {
  public readonly reason: BErrorReason;
  public readonly errorClass: ErrorClass;
  /** Só em escrita: o B pode ter aplicado a operação apesar do erro. */
  public readonly ambiguous: boolean;
  public readonly status: number | undefined;
  /** Quanto esperar antes de tentar de novo (Retry-After do 429, tempo restante do disjuntor). */
  public readonly retryAfterMs: number | undefined;

  constructor(
    reason: BErrorReason,
    message: string,
    options: { write?: boolean; status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BError';
    this.reason = reason;
    this.errorClass = TRANSIENT.has(reason) ? 'transient' : 'permanent';
    this.ambiguous = (options.write ?? false) && MAYBE_WRITTEN.has(reason);
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }

  get transient(): boolean {
    return this.errorClass === 'transient';
  }
}

/** Classifica um status HTTP de erro (não 2xx). */
export function reasonForStatus(status: number): BErrorReason {
  if (status === 429) return 'rate_limited';
  if (status === 404) return 'not_found';
  if (status === 412) return 'precondition_failed';
  if (status === 408 || status >= 500) return 'server_error';
  return 'rejected';
}
