import { readFileSync } from 'node:fs';
import { localPool } from '../../../packages/db/src/postgres.ts';

export const LEGACY_DATABASE='vista_verde_local';
export const WORK_DATABASE='vista_verde_work_orders';
export const WORK_PROFILE='vista-verde-work-orders.v0.3';
export function workOrderDemoEnabled(env:NodeJS.ProcessEnv=process.env):boolean {
  if (env.VV_WORK_ORDER_DEMO_ENABLED===undefined || env.VV_WORK_ORDER_DEMO_ENABLED==='false') return false;
  if (env.VV_WORK_ORDER_DEMO_ENABLED!=='true') throw new Error('Invalid isolated demo enablement.');
  return true;
}
export function localConfiguration(target:'configured'|'legacy'|'work'|'maintenance'='configured') {
  if (process.env.VV_LOCAL_MODE!=='synthetic_loopback') throw new Error('Local operating mode must be explicit.');
  const key=readFileSync('/run/vista-verde/fixture-key','utf8').trim();
  const password=readFileSync('/run/vista-verde/database-password','utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(key) || !/^[a-f0-9]{64}$/.test(password)) throw new Error('Invalid local secret input.');
  const user=process.env.VV_DATABASE_USER ?? 'vista_verde_app';
  if (!['postgres','vista_verde_app'].includes(user)) throw new Error('Invalid local database role.');
  const enabled=workOrderDemoEnabled();
  if (target==='work' && !enabled) throw new Error('Work-order store must be explicitly enabled.');
  if (target==='maintenance' && user!=='postgres') throw new Error('Maintenance requires the existing bootstrap role.');
  const database=target==='maintenance' ? 'postgres':target==='legacy' ? LEGACY_DATABASE:target==='work' || enabled ? WORK_DATABASE:LEGACY_DATABASE;
  return { key,database,pool:localPool(`postgresql://${user}:${password}@127.0.0.1:5432/${database}`,1) };
}
