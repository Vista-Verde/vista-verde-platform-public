import type pg from 'pg';
import { businessSnapshot,reconcileLocal } from '../../../packages/db/src/local-operations.ts';
import { WORK_DATABASE,WORK_PROFILE } from './config.ts';
export async function exportSnapshot(pool:pg.Pool,work=false):Promise<void> {
  const client=await pool.connect();let locked=false;
  const watchdog=setTimeout(() => process.stdin.destroy(),120000);watchdog.unref();
  try {
    if (work) {
      const database=(await client.query('SELECT current_database() AS name')).rows[0].name;
      const schema=(await client.query('SELECT version FROM market_schema')).rows;
      if (database!==WORK_DATABASE || schema.length!==1 || schema[0].version!=='market.v0.3') throw new Error('Work backup profile mismatch.');
    }
    await client.query("SET lock_timeout='5s'");
    await client.query("SELECT pg_advisory_lock(hashtextextended('vista-verde-local-backup',0))");locked=true;
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await reconcileLocal(client);const business=await businessSnapshot(client);
    const grants=(await client.query('SELECT id,actor_id,operations,requirement_scopes,market_scopes,expires_at,revoked,max_per_command,budget_limit,used_minor FROM grants ORDER BY id')).rows;
    const snapshot=(await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
    console.log(JSON.stringify({ snapshot,business,grants,evidenceFiles:[],synthetic:true,...(work ? { database:WORK_DATABASE,profile:WORK_PROFILE }:{}) }));
    for await (const bytes of process.stdin) if (bytes.length) break;
    await client.query('COMMIT');
  } catch { console.error('Profile-bound snapshot failed safely.');await client.query('ROLLBACK');process.exitCode=1; }
  finally {
    clearTimeout(watchdog);if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended('vista-verde-local-backup',0))");
    client.release();await pool.end();
  }
}
