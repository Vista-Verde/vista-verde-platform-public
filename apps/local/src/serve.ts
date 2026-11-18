import { startHttp } from '../../api/src/http.ts';
import { fixtureTokens } from '../../../packages/db/src/local-operations.ts';
import { localConfiguration,workOrderDemoEnabled } from './config.ts';
import { createHash } from 'node:crypto';
import { ownerAccessConfiguration,ownerStorybookConfiguration,startOwnerAccess } from './owner-access.ts';
import { startProducerProcess } from '../../producer-demo/process.ts';
const { key,pool }=localConfiguration(); const tokens=fixtureTokens(key);
const connection=pool.options.connectionString!;
const personas=Object.fromEntries([['buyer-agent','Buyer agent · draft demand'],['buyer','Buyer human · review & publish'],['producer-a','Producer A · reviewed fixture'],['producer-b','Producer B · reviewed fixture']].map(([id,label]) => [id!,{ label:label!,token:tokens[id!]! }]));
let api:Awaited<ReturnType<typeof startHttp>>|undefined;
let owner:Awaited<ReturnType<typeof startOwnerAccess>>|undefined;
let producer:Awaited<ReturnType<typeof startProducerProcess>>|undefined;
let closing=false;
const close=async () => { if (closing) return; closing=true; await owner?.close(); await api?.close(); await producer?.close(); await pool.end(); };
try {
  const ownerConfig=ownerAccessConfiguration(),storybook=ownerStorybookConfiguration();
  if(workOrderDemoEnabled())producer=await startProducerProcess(4320,process.env.VV_PRODUCER_STATE_FILE);
  producer?.onFailure(()=>{console.error('Simulated producer stopped; restarting the bounded demo.');void close().finally(()=>{process.exitCode=1;});});
  api=await startHttp(connection,'local_test',{ personas,port:4318,storybook:false,legacy:!workOrderDemoEnabled(),...(producer?{producer:producer.client}:{}),ready:async () => {
    if(producer)await producer.client.health();
    const schema=(await pool.query('SELECT version FROM foundation_schema')).rows;
    const market=(await pool.query('SELECT version FROM market_schema')).rows;
    const valid=(await pool.query('SELECT count(*) AS n FROM grants WHERE token_hash=ANY($1::text[]) AND NOT revoked AND expires_at>clock_timestamp()', [Object.keys(personas).map(actor => createHash('sha256').update(tokens[actor]!).digest('hex'))])).rows[0].n;
    return schema.length===1 && schema[0].version==='foundation.v0.1' && market.length===1 && market[0].version==='market.v0.3' && Number(valid)===4;
  } });
  if (ownerConfig) owner=await startOwnerAccess(api.url,ownerConfig,{ ...(storybook ? { storybook }:{}) });
  console.log('Vista Verde synthetic local workspace ready at http://127.0.0.1:4318 (loopback only).');
  process.once('SIGTERM',() => { void close(); }); process.once('SIGINT',() => { void close(); });
} catch { console.error('Local app startup failed safely; isolated database, fixture authority or owner boundary unavailable.'); await close();process.exitCode=1; }
