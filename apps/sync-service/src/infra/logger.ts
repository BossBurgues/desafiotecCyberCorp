import { pino, type Logger } from 'pino';

/** Campos que nunca vão para o log, nem em requisições nem em objetos de erro. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-hub-signature-256"]',
  'req.headers["app-token"]',
  'req.headers["session-token"]',
  'req.headers["x-admin-token"]',
  '*.password',
  '*.token',
  '*.databaseUrl',
];

export function createLogger(level: string, destination?: pino.DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: 'sync-service' },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[mascarado]' },
    },
    destination,
  );
}
