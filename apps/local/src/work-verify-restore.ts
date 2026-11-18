import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { localConfiguration,WORK_DATABASE,WORK_PROFILE } from './config.ts';
import { localPool } from '../../../packages/db/src/postgres.ts';
import { businessSnapshot,reconcileLocal } from '../../../packages/db/src/local-operations.ts';
const database=process.argv[2],prepare=process.argv[3]==='--prepare-authority';
if (!/^vv_restore_[a-f0-9]{24}$/.test(database ?? '') || (process.argv[3]!==undefined && !prepare)) throw new Error('Only a unique isolated restore database is permitted.');
const config=localConfiguration('work'),url=new URL(config.pool.options.connectionString!); url.pathname=`/${database}`;
await config.pool.end(); const pool=localPool(url.toString(),1); const client=await pool.connect();
try {
  let input=''; for await (const bytes of process.stdin) { input+=bytes.toString(); if (Buffer.byteLength(input)>262144) throw new Error('Restore manifest too large.'); }
  const grant=z.object({ id:z.string().max(100),actor_id:z.string().max(100),operations:z.array(z.string().max(100)).max(64),requirement_scopes:z.array(z.string().max(100)).max(100),market_scopes:z.array(z.string().max(100)).max(100),expires_at:z.string(),revoked:z.boolean(),max_per_command:z.string(),budget_limit:z.string(),used_minor:z.string() }).strict();
  const metadata=z.object({ database:z.literal(WORK_DATABASE),profile:z.literal(WORK_PROFILE),business:z.object({ checksum:z.string().regex(/^[a-f0-9]{64}$/),counts:z.record(z.string(),z.number().int().nonnegative()) }),grants:z.array(grant).max(32) }).strict().parse(JSON.parse(input));
  if (new Set(metadata.grants.map(g => g.id)).size!==metadata.grants.length) throw new Error('Duplicate restored authority.');
  await client.query('BEGIN');
  if (Number((await client.query('SELECT count(*) AS n FROM local_operation_state')).rows[0].n)!==0) throw new Error('Restore target contains local operating authority.');
  if (prepare) {
    // Restore pre-data and data first. Rebuild ONLY disabled, credential-free
    // grant references before post-data validates historical approval FKs.
    if (Number((await client.query('SELECT count(*) AS n FROM grants')).rows[0].n)!==0) throw new Error('Restore target contains authority.');
    for (const g of metadata.grants) await client.query(`INSERT INTO grants(id,actor_id,token_hash,operations,requirement_scopes,market_scopes,expires_at,revoked,max_per_command,budget_limit,used_minor)
      VALUES($1,$2,$3,$4,$5,$6,$7,true,$8,$9,$10)`,[g.id,g.actor_id,`disabled-restore-${randomUUID()}`,g.operations,g.requirement_scopes,g.market_scopes,g.expires_at,g.max_per_command,g.budget_limit,g.used_minor]);
    await client.query('COMMIT'); console.log(JSON.stringify({database,sourceDatabase:WORK_DATABASE,profile:WORK_PROFILE,prepared:true,credentialsRestored:false,grantsDisabled:true}));
  } else {
    const restored=(await client.query('SELECT * FROM grants ORDER BY id')).rows;
    if (restored.length!==metadata.grants.length) throw new Error('Unexpected restored authority.');
    for (const g of metadata.grants) {
      const actual=restored.find(row => row.id===g.id);
      if (!actual || actual.revoked!==true || !/^disabled-restore-[a-f0-9-]{36}$/.test(actual.token_hash)
        || actual.actor_id!==g.actor_id || JSON.stringify(actual.operations)!==JSON.stringify(g.operations)
        || JSON.stringify(actual.requirement_scopes)!==JSON.stringify(g.requirement_scopes) || JSON.stringify(actual.market_scopes)!==JSON.stringify(g.market_scopes)
        || (actual.expires_at as Date).getTime()!==Date.parse(g.expires_at) || actual.max_per_command!==g.max_per_command
        || actual.budget_limit!==g.budget_limit || actual.used_minor!==g.used_minor) throw new Error('Restored authority differs from disabled metadata.');
    }
    await reconcileLocal(client); const found=await businessSnapshot(client);
    if (found.checksum!==metadata.business.checksum || JSON.stringify(found.counts)!==JSON.stringify(metadata.business.counts)) throw new Error('Restore differs from backup snapshot.');
    await client.query('COMMIT'); console.log(JSON.stringify({ database,sourceDatabase:WORK_DATABASE,profile:WORK_PROFILE,...found,verified:true,credentialsRestored:false,grantsDisabled:true }));
  }
} catch { await client.query('ROLLBACK'); console.error('Isolated restore verification failed safely.'); process.exitCode=1; }
finally { client.release(); await pool.end(); }
