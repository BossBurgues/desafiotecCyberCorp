import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';

const valid = {
  DATABASE_URL: 'postgres://sync:segredo-do-banco@localhost:5432/sync',
  A_BASE_URL: 'http://localhost:3001/',
  B_BASE_URL: 'http://localhost:5002',
  A_APP_TOKEN: 'app-token',
  A_SYNC_BOT_TOKEN: 'sync-bot-token',
  HMAC_SECRET: 'segredo-hmac-de-teste-0000',
};

describe('loadConfig', () => {
  it('aplica os padrões e tira a barra final das URLs', () => {
    const c = loadConfig(valid);
    expect(c).toMatchObject({
      NODE_ENV: 'development',
      HOST: '0.0.0.0',
      PORT: 3000,
      LOG_LEVEL: 'info',
      A_BASE_URL: 'http://localhost:3001',
      READY_CHECK_TIMEOUT_MS: 2000,
      READY_CHECK_INTERVAL_MS: 5000,
      WORKER_POLL_INTERVAL_MS: 1000,
      B_TIMEOUT_MS: 5000,
      B_BREAKER_THRESHOLD: 5,
      B_BREAKER_OPEN_MS: 30000,
      QUEUE_LEASE_MS: 60000,
      QUEUE_BACKOFF_BASE_MS: 1000,
      QUEUE_BACKOFF_MAX_MS: 300000,
      QUEUE_TRANSIENT_MAX_AGE_MS: 86400000,
      QUEUE_PERMANENT_MAX_ATTEMPTS: 3,
    });
  });

  it('VERIFY_AFTER_WRITE vem ligado por padrão e só desliga com "false"', () => {
    expect(loadConfig(valid).VERIFY_AFTER_WRITE).toBe(true);
    expect(loadConfig({ ...valid, VERIFY_AFTER_WRITE: 'false' }).VERIFY_AFTER_WRITE).toBe(false);
    expect(() => loadConfig({ ...valid, VERIFY_AFTER_WRITE: 'nao' })).toThrow(ConfigError);
  });

  it('converte números vindos do ambiente como texto', () => {
    expect(loadConfig({ ...valid, PORT: '8080', READY_CHECK_TIMEOUT_MS: '500' })).toMatchObject({
      PORT: 8080,
      READY_CHECK_TIMEOUT_MS: 500,
    });
  });

  it('lista todos os problemas de uma vez em vez de parar no primeiro', () => {
    try {
      loadConfig({ PORT: '70000', LOG_LEVEL: 'barulhento' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const fields = (err as ConfigError).problems.map((p) => p.split(':')[0]);
      expect(fields).toEqual(
        expect.arrayContaining(['PORT', 'LOG_LEVEL', 'DATABASE_URL', 'A_BASE_URL', 'B_BASE_URL']),
      );
    }
  });

  it('recusa URL com protocolo errado', () => {
    expect(() => loadConfig({ ...valid, DATABASE_URL: 'mysql://localhost/sync' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...valid, B_BASE_URL: 'ftp://b.local' })).toThrow(ConfigError);
  });

  it('nunca coloca o valor das variáveis na mensagem de erro', () => {
    try {
      loadConfig({ ...valid, A_BASE_URL: 'nao-e-url', PORT: 'segredo-do-banco' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('segredo-do-banco');
    }
  });
});
