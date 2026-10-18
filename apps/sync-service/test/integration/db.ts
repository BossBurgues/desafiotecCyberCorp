import { randomBytes } from 'node:crypto';
import pg from 'pg';

/**
 * Banco dos testes de integração. Na CI é obrigatório (TEST_DATABASE_URL vem do service container);
 * localmente, sem a variável, os testes de integração são pulados.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL && process.env.CI) {
  throw new Error('TEST_DATABASE_URL é obrigatório na CI para os testes de integração');
}

/** Pool preso a um schema novo e vazio: cada arquivo de teste começa do zero, sem limpar o banco dos outros. */
export async function isolatedPool(): Promise<{ pool: pg.Pool; drop: () => Promise<void> }> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4, options: `-c search_path=${schema}` });
  return {
    pool,
    drop: async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}
