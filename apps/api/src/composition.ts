import { Application } from '../../../packages/domain/src/index.ts';
import { localPool, PostgresRepository } from '../../../packages/db/src/postgres.ts';
import { BASELINE } from '../../../packages/contracts/src/index.ts';

export async function compose(connectionString: string, mode: string | undefined) {
  if (mode !== 'local_test') throw new Error('Fixture authority is permitted only in explicit local_test mode.');
  const pool = localPool(connectionString,4);
  try {
    const schema = await pool.query('SELECT version FROM foundation_schema');
    if (schema.rows.length !== 1 || schema.rows[0].version !== BASELINE) throw new Error('Unsupported foundation schema.');
    const market = await pool.query('SELECT version FROM market_schema');
    if (market.rows.length !== 1 || market.rows[0].version !== 'market.v0.3') throw new Error('Unsupported market schema.');
  } catch { await pool.end(); throw new Error('Foundation and market schema readiness failed.'); }
  const repository = new PostgresRepository(pool);
  return { pool,repository,application: new Application(repository) };
}
