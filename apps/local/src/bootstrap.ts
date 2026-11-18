import { readFileSync } from 'node:fs';
import { bootstrapLocal } from '../../../packages/db/src/local-operations.ts';
import { localConfiguration,workOrderDemoEnabled } from './config.ts';
import { bootstrapWorkOrderStore } from './work-store.ts';
let pool:ReturnType<typeof localConfiguration>['pool']|undefined;
try {
const enabled=workOrderDemoEnabled();
if (enabled) {
  const maintenance=localConfiguration('maintenance');
  try { await bootstrapWorkOrderStore(maintenance.pool,maintenance.key); }
  finally { await maintenance.pool.end(); }
}
const config=localConfiguration();pool=config.pool;const { key,database }=config;
  await bootstrapLocal(pool,key);
  const password=readFileSync('/run/vista-verde/application-password','utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(password)) throw new Error('Invalid local application password.');
  // Role DDL cannot bind parameters; only fixed role names and validated hex enter it.
  const role=await pool.query("SELECT 1 FROM pg_roles WHERE rolname='vista_verde_app'");
  if (!role.rowCount) {
    if (enabled) throw new Error('Isolated work store requires the existing application role.');
    await pool.query(`CREATE ROLE vista_verde_app LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
  }
  else {
    const found=(await pool.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname='vista_verde_app'")).rows[0];
    if (Object.values(found).some(Boolean)) throw new Error('Existing application role has unexpected privileges.');
  }
  await pool.query(database==='vista_verde_work_orders' ? 'GRANT CONNECT ON DATABASE vista_verde_work_orders TO vista_verde_app':'GRANT CONNECT ON DATABASE vista_verde_local TO vista_verde_app');
  await pool.query('GRANT USAGE ON SCHEMA public TO vista_verde_app');
  await pool.query('GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO vista_verde_app');
  await pool.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO vista_verde_app');
  console.log('Local synthetic schema initialized/verified; existing funds and authority preserved.');
} catch { console.error('Local bootstrap failed safely; inspect schema/secret compatibility.'); process.exitCode=1; }
finally { await pool?.end(); }
