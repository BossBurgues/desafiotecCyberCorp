import type { Lookups } from '../../domain/types.js';

/**
 * Catálogos do A com cache: são cadastros que quase não mudam, e o worker precisa deles em todo job.
 * Uma carga em andamento é compartilhada (vários jobs ao mesmo tempo fazem uma requisição só). Falha não fica no
 * cache: o job volta para a fila (erro transitório do A) e a próxima tentativa recarrega.
 */
export function cachedLookups(load: () => Promise<Lookups>, ttlMs: number, now: () => number = Date.now): () => Promise<Lookups> {
  let value: Lookups | null = null;
  let loadedAt = 0;
  let inFlight: Promise<Lookups> | null = null;

  return async () => {
    if (value && now() - loadedAt < ttlMs) return value;
    inFlight ??= load()
      .then((v) => {
        value = v;
        loadedAt = now();
        return v;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
