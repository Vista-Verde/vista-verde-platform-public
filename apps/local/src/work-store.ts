import type pg from 'pg';
import { localPool } from '../../../packages/db/src/postgres.ts';
import { bootstrapLocal } from '../../../packages/db/src/local-operations.ts';
import { WORK_DATABASE } from './config.ts';

// The existing admin credential is reused privately. There is no old-store
// migration, reseed, password rotation, user-selected database or DROP path.
export async function bootstrapWorkOrderStore(admin:pg.Pool,key:string):Promise<void> {
  const source=new URL(admin.options.connectionString!);
  if (source.username!=='postgres' || source.pathname!=='/postgres') throw new Error('Isolated bootstrap requires the fixed maintenance database.');
  const client=await admin.connect();let locked=false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended('vista-verde-work-orders-bootstrap',0))");locked=true;
    const role=(await client.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolcanlogin FROM pg_roles WHERE rolname='vista_verde_app'")).rows[0];
    if (!role || !role.rolcanlogin || role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication)
      throw new Error('Isolated work store requires the existing limited application role.');
    const exists=await client.query('SELECT 1 FROM pg_database WHERE datname=$1',[WORK_DATABASE]);
    if (!exists.rowCount) await client.query('CREATE DATABASE vista_verde_work_orders');
    source.pathname=`/${WORK_DATABASE}`;const target=localPool(source.toString(),1);
    try {
      const namespaces=await target.query("SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('public','pg_catalog','information_schema') AND nspname !~ '^pg_'");
      if (namespaces.rowCount) throw new Error('Isolated target contains an unexpected schema.');
      const marker=(await target.query("SELECT to_regclass('public.local_operation_state') AS marker")).rows[0].marker;
      if (!marker) {
        const objects=(await target.query("SELECT (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace)+(SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace)+(SELECT count(*) FROM pg_type WHERE typnamespace='public'::regnamespace) AS n")).rows[0].n;
        if (Number(objects)!==0) throw new Error('Isolated target is not empty.');
      }
      // bootstrapLocal atomically seeds only a completely empty target, and
      // verifies exact v0.3 schema/key binding on restart without changing grants.
      await bootstrapLocal(target,key);
    } finally { await target.end(); }
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended('vista-verde-work-orders-bootstrap',0))");
    client.release();
  }
}
