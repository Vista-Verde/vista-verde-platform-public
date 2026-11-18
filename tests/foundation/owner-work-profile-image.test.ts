import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes,randomUUID,createHash } from 'node:crypto';
import { spawn,spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type pg from 'pg';
import { localPool } from '../../packages/db/src/postgres.ts';
import { businessSnapshot } from '../../packages/db/src/local-operations.ts';
import { LEGACY_DATABASE,WORK_DATABASE,WORK_PROFILE } from '../../apps/local/src/config.ts';
import { draft } from '../../packages/db/src/fixtures.ts';
import { workOrderInput,responseInput } from './market-helpers.ts';

type Business={checksum:string;counts:Record<string,number>};
type Metadata={business:Business;grants:{actor_id:string;revoked:boolean;used_minor:string}[];snapshot:string;database?:string;profile?:string;synthetic:boolean;evidenceFiles:unknown[]};
function docker(args:string[],input?:string|Buffer){
  const result=spawnSync('docker',args,{input,encoding:'utf8',maxBuffer:16*1024*1024});
  assert.equal(result.status,0,`Owned disposable Docker operation ${args[0]} succeeds`);return result.stdout.trim();
}

test('compiled owner work profiles: fixed new store and canonical legacy store survive restart, export distinct database snapshots, and restore exact records with disabled credentials', {timeout:180000},async t=>{
  const image=process.env.VV_LOCAL_TEST_IMAGE;assert.ok(image,'Use the freshly built isolated owner work candidate image');
  assert.equal(docker(['context','show']),'orbstack');assert.equal(docker(['image','inspect',image,'--format','{{.Architecture}}']),'arm64');
  const suffix=randomUUID(),dbName=`vv-owner-profiles-${suffix}`,network=`${dbName}-network`,app=`${dbName}-app`,volume=`${dbName}-data`;
  const directory=mkdtempSync(join(tmpdir(),'vv-owner-profiles-')),adminPassword=randomBytes(32).toString('hex'),appPassword=randomBytes(32).toString('hex'),key=randomBytes(32).toString('hex');
  for(const [folder,files] of Object.entries({admin:{'database-password':adminPassword},bootstrap:{'database-password':adminPassword,'application-password':appPassword,'fixture-key':key},app:{'database-password':appPassword,'fixture-key':key}})){
    mkdirSync(join(directory,folder),{mode:0o755});for(const [file,value] of Object.entries(files))writeFileSync(join(directory,folder,file),value,{mode:0o444});
  }
  const pools:pg.Pool[]=[];const snapshots:ReturnType<typeof spawn>[]=[];
  t.after(async()=>{
    for(const process of snapshots)if(!process.stdin?.writableEnded)process.stdin?.end('finish\n');
    await Promise.all(pools.map(pool=>pool.end()));
    for(const name of [app,dbName,network])spawnSync('docker',['rm','-f',name],{stdio:'ignore'});
    spawnSync('docker',['volume','rm',volume],{stdio:'ignore'});
    rmSync(directory,{recursive:true,force:true});
  });
  const fixtureLabel='vista-verde.fixture=owner-work-profiles';
  // UUID-owned container namespace, disposable volume and generated secrets. Nothing
  // resolves an external database, contacts Kubernetes or mounts a backup drive.
  docker(['run','--detach','--pull=never','--name',network,'--label',fixtureLabel,'--memory','64m','--cpus','0.1','--read-only','--publish','127.0.0.1::5432',image,'node','-e','setInterval(()=>{},1000)']);
  docker(['volume','create','--label',fixtureLabel,volume]);
  docker(['run','--detach','--pull=never','--name',dbName,'--label',fixtureLabel,'--network',`container:${network}`,'--memory','1g','--cpus','1','--mount',`type=volume,source=${volume},target=/var/lib/postgresql/data`,
    '--mount',`type=bind,source=${join(directory,'admin')},target=/run/vista-verde,readonly`,'--env',`POSTGRES_DB=${LEGACY_DATABASE}`,'--env','POSTGRES_PASSWORD_FILE=/run/vista-verde/database-password',
    '--env','POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=scram-sha-256','postgres@sha256:5a65324fe84dc41709ff914e90b07f3e2f577073ed27bf917d4873aca0c9ec51','postgres','-c','max_connections=20','-c','shared_buffers=128MB','-c','log_min_error_statement=panic']);
  const port=docker(['port',network,'5432/tcp']).match(/^127\.0\.0\.1:(\d+)$/)?.[1];assert.ok(port);
  const connect=(database:string)=>{const pool=localPool(`postgresql://postgres:${adminPassword}@127.0.0.1:${port}/${database}`,1);pools.push(pool);return pool;};
  const old=connect(LEGACY_DATABASE),maintenance=connect('postgres');
  for(let attempt=0;;attempt++){try{await old.query('SELECT 1');break;}catch{if(attempt>=100)throw new Error('Owned PostgreSQL readiness failed');await delay(100);}}
  const invocation=(folder:'bootstrap'|'app',args:string[],enabled=true)=>['run','--rm','--pull=never','-i','--network',`container:${network}`,'--read-only','--env','VV_LOCAL_MODE=synthetic_loopback','--env',`VV_WORK_ORDER_DEMO_ENABLED=${enabled}`,
    ...(folder==='bootstrap'?['--env','VV_DATABASE_USER=postgres']:[]),'--mount',`type=bind,source=${join(directory,folder)},target=/run/vista-verde,readonly`,image,...args];
  docker(invocation('bootstrap',['node','legacy-dist/apps/local/src/bootstrap.js'],false));
  const legacyURL=new URL('../../legacy-dist/packages/db/src/local-operations.js',import.meta.url).href;
  const legacy=await import(legacyURL) as {businessSnapshot:(client:pg.PoolClient)=>Promise<Business>};
  const state=async(pool:pg.Pool,legacyStore=false)=>{const client=await pool.connect();try{return{
    business:await (legacyStore?legacy.businessSnapshot(client):businessSnapshot(client)),
    authority:createHash('sha256').update(JSON.stringify((await client.query('SELECT to_jsonb(g) AS record FROM grants g ORDER BY id')).rows)).digest('hex'),
    bootstrap:(await client.query('SELECT to_jsonb(s) AS record FROM local_operation_state s')).rows};}finally{client.release();}};
  const oldProgram=`
    import {localConfiguration} from './legacy-dist/apps/local/src/config.js';
    import {fixtureTokens} from './legacy-dist/packages/db/src/local-operations.js';
    import {PostgresRepository} from './legacy-dist/packages/db/src/postgres.js';
    import {Application} from './legacy-dist/packages/domain/src/index.js';
    import {draft,publication,purchase} from './legacy-dist/packages/db/src/fixtures.js';
    const {pool,key}=localConfiguration(),repository=new PostgresRepository(pool),application=new Application(repository),tokens=fixtureTokens(key);
    const call=async(actor,operation,input)=>{const receipt=await application.execute(operation,input,await repository.authenticate(tokens[actor]));if(!receipt.ok)throw new Error(operation+' failed');return receipt;};
    try{const created=await call('buyer-agent','createRequirementDraft',draft('original-canonical-owned-profiles'));
      await call('buyer','publishRequirement',publication(created.recordIds.requirementId,'original-profile-slot',6000,new Date(Date.now()+86400000).toISOString()));
      const bought=await call('producer-a','purchaseSlot',purchase('original-profile-slot'));
      console.log(JSON.stringify({requirementId:created.recordIds.requirementId,commitmentId:bought.recordIds.commitmentId}));
    }finally{await pool.end();}`;
  const original=JSON.parse(docker(invocation('app',['node','--input-type=module','-e',oldProgram],false))) as {requirementId:string;commitmentId:string};
  await old.query("UPDATE grants SET revoked=true,used_minor=4321 WHERE actor_id='buyer-second'");const oldBefore=await state(old,true);
  assert.equal((await old.query("SELECT to_regclass('public.market_schema') AS marker")).rows[0].marker,null);
  docker(invocation('bootstrap',['node','dist/apps/local/src/bootstrap.js']));const work=connect(WORK_DATABASE);
  assert.deepEqual(await state(old,true),oldBefore,'New bootstrap leaves every canonical business record, grant and binding unchanged');
  docker(['run','--detach','--pull=never','--name',app,'--label',fixtureLabel,'--network',`container:${network}`,'--read-only','--memory','512m','--cpus','1','--env','VV_LOCAL_MODE=synthetic_loopback','--env','VV_WORK_ORDER_DEMO_ENABLED=true',
    '--mount',`type=bind,source=${join(directory,'app')},target=/run/vista-verde,readonly`,image]);
  const healthy=async()=>{for(let attempt=0;attempt<100;attempt++){if(spawnSync('docker',['exec',app,'node','dist/apps/local/src/health.js','ready'],{stdio:'ignore'}).status===0)return;await delay(100);}throw new Error('Compiled work app readiness failed');};await healthy();
  const beforeOldDocument=await state(work);
  const oldDocumentProgram=`
    let data='';for await(const chunk of process.stdin)data+=chunk;const input=JSON.parse(data),origin='http://127.0.0.1:4318';
    const boot=await fetch(origin+'/session'),anonymous=await boot.json(),cookie=boot.headers.get('set-cookie').split(';')[0];
    const exchange=await fetch(origin+'/session',{method:'POST',headers:{cookie,origin,'content-type':'application/json','x-csrf-token':anonymous.csrf},body:JSON.stringify({persona:'buyer-agent'})});
    if(!exchange.ok)throw new Error('Fresh compiled fixture session failed');const session=await exchange.json();
    const response=await fetch(origin+'/commands/createRequirementDraft',{method:'POST',headers:{cookie:exchange.headers.get('set-cookie').split(';')[0],origin,'content-type':'application/json','x-csrf-token':session.csrf},body:JSON.stringify(input)});
    console.log(JSON.stringify({status:response.status,receipt:await response.json()}));`;
  const denied=JSON.parse(docker(['exec','-i',app,'node','--input-type=module','-e',oldDocumentProgram],JSON.stringify(draft('original-open-document-compiled-recovery'))));
  assert.equal(denied.status,403);assert.equal(denied.receipt.ok,false);assert.equal(denied.receipt.code,'FORBIDDEN');
  assert.deepEqual(await state(work),beforeOldDocument,'An already-open original document cannot write through a fresh compiled work-runtime session');
  const workProgram=`
    import {localConfiguration} from './dist/apps/local/src/config.js';
    import {fixtureTokens} from './dist/packages/db/src/local-operations.js';
    import {PostgresRepository} from './dist/packages/db/src/postgres.js';
    import {Application} from './dist/packages/domain/src/index.js';
    let data='';for await(const chunk of process.stdin)data+=chunk;const input=JSON.parse(data);
    const {pool,key}=localConfiguration('work'),repository=new PostgresRepository(pool),application=new Application(repository),tokens=fixtureTokens(key);
    const call=async(actor,operation,args)=>{const receipt=await application.execute(operation,args,await repository.authenticate(tokens[actor]));if(!receipt.ok)throw new Error(operation+' failed: '+receipt.code);return receipt;};
    try{const posted=await call('buyer','postWorkOrder',input.work);input.response.workOrderId=posted.recordIds.workOrderId;
      const proposed=await call('producer-a','respondToWorkOrder',input.response),proposalId=proposed.recordIds.proposalId;
      await call('buyer','confirmMarketProposal',{idempotencyKey:'profiles-buyer-approval',proposalId,expectedRecordVersion:1});
      const commitment=await call('producer-a','confirmMarketProposal',{idempotencyKey:'profiles-seller-approval',proposalId,expectedRecordVersion:2}),commitmentId=commitment.recordIds.commitmentId;
      const report=await call('producer-a','reportMarketFulfillment',{idempotencyKey:'profiles-report-five',commitmentId,expectedRecordVersion:1,quantity:{value:5,unit:'each'},note:'Owned synthetic profile restore proof'});
      await call('buyer','acknowledgeMarketFulfillment',{idempotencyKey:'profiles-ack-five',fulfillmentId:report.recordIds.fulfillmentId,expectedRecordVersion:1});
      console.log(JSON.stringify({workOrderId:posted.recordIds.workOrderId,proposalId,commitmentId,fulfillmentId:report.recordIds.fulfillmentId}));
    }finally{await pool.end();}`;
  const ids=JSON.parse(docker(['exec','-i',app,'node','--input-type=module','-e',workProgram],JSON.stringify({work:workOrderInput('profiles-actual-work',8,72000,{itemId:'PRINT-JOB-SYNTH',availableAt:new Date().toISOString(),deliveryBy:new Date(Date.now()+7*86400000).toISOString(),printRequirements:{version:'mock-print.v1',profile:'FDM-PETG-175-BLACK-SYNTH',mesh:{format:'binary',triangles:12,bounds:[20,20,20],units:'mm',synthetic:true},materialResponsibility:'producer',delivery:{mode:'mock_courier',zone:'A',allowance:{minorUnits:1000,currency:'USD'}}}}),response:responseInput('profiles-private-response','placeholder',8,9000,{expiresAt:new Date(Date.now()+3600000).toISOString()})}))) as {workOrderId:string;proposalId:string;commitmentId:string;fulfillmentId:string};
  await work.query("UPDATE grants SET revoked=true,used_minor=8765 WHERE actor_id='buyer-second'");const workBefore=await state(work);
  const roleBefore=(await maintenance.query("SELECT rolpassword,rolsuper,rolcreatedb,rolcreaterole,rolreplication FROM pg_authid WHERE rolname='vista_verde_app'")).rows;
  docker(['restart',app]);await healthy();docker(invocation('bootstrap',['node','dist/apps/local/src/bootstrap.js']));docker(invocation('bootstrap',['node','legacy-dist/apps/local/src/bootstrap.js'],false));
  assert.deepEqual(await state(old,true),oldBefore);assert.deepEqual(await state(work),workBefore);
  const appStarted=JSON.parse(docker(['inspect',app]))[0].State.StartedAt;
  docker(['restart',dbName]);
  for(let attempt=0;;attempt++){try{await maintenance.query('SELECT 1');break;}catch{if(attempt>=100)throw new Error('Owned PostgreSQL restart readiness failed');await delay(100);}}
  docker(invocation('bootstrap',['node','dist/apps/local/src/bootstrap.js']));await healthy();
  assert.equal(JSON.parse(docker(['inspect',app]))[0].State.StartedAt,appStarted,'The separate database restart does not restart the work app');
  assert.deepEqual(await state(old,true),oldBefore);assert.deepEqual(await state(work),workBefore);
  assert.deepEqual((await maintenance.query("SELECT rolpassword,rolsuper,rolcreatedb,rolcreaterole,rolreplication FROM pg_authid WHERE rolname='vista_verde_app'")).rows,roleBefore,'Neither bootstrap rotates the shared credential or elevates privileges');
  assert.equal((await work.query('SELECT count(*) FROM requirements WHERE id=$1',[original.requirementId])).rows[0].count,'0');
  const shell=(code:string,input?:Buffer)=>docker(['exec','-i',dbName,'sh','-c',`export PGPASSWORD="$(cat /run/vista-verde/database-password)"; ${code}`],input);
  async function snapshot(script:string,source:string,other:string){
    const session=spawn('docker',['exec','-i',app,'node',script],{stdio:['pipe','pipe','pipe']});snapshots.push(session);session.stderr.resume();const exit=once(session,'exit'),lines=createInterface({input:session.stdout});
    try{const first=await Promise.race([once(lines,'line').then(([line])=>String(line)),exit.then(()=>{throw new Error('Profile snapshot failed before export');})]);
      const metadata=JSON.parse(first) as Metadata;assert.match(metadata.snapshot,/^[a-fA-F0-9-]{1,64}$/);assert.equal(metadata.synthetic,true);assert.deepEqual(metadata.evidenceFiles,[]);
      const dumpCommand=(database:string)=>`export PGPASSWORD="$(cat /run/vista-verde/database-password)"; exec pg_dump -h 127.0.0.1 -U postgres -d ${database} --format=custom --no-owner --no-acl --exclude-table-data=public.grants --exclude-table-data=public.local_operation_state --snapshot=${metadata.snapshot}`;
      const wrong=spawnSync('docker',['exec',dbName,'sh','-c',dumpCommand(other)],{maxBuffer:16*1024*1024});assert.notEqual(wrong.status,0,'A snapshot cannot be imported into the other profile database');assert.match(wrong.stderr.toString(),/different database/);
      const dump=spawnSync('docker',['exec',dbName,'sh','-c',dumpCommand(source)],{maxBuffer:16*1024*1024});assert.equal(dump.status,0,'Each snapshot dumps only its own bound database');
      session.stdin.end('finish\n');assert.equal((await exit)[0],0);return{metadata,data:dump.stdout};
    }finally{if(!session.stdin.writableEnded)session.stdin.end('finish\n');lines.close();}
  }
  const originalBackup=await snapshot('dist/apps/local/src/snapshot.js',LEGACY_DATABASE,WORK_DATABASE),workBackup=await snapshot('dist/apps/local/src/work-snapshot.js',WORK_DATABASE,LEGACY_DATABASE);
  assert.deepEqual(originalBackup.metadata.business,oldBefore.business);assert.equal(originalBackup.metadata.database,undefined);assert.equal(originalBackup.metadata.profile,undefined);
  assert.equal(originalBackup.metadata.business.counts.market_orders,undefined,'Legacy snapshot continues using its frozen business schema');
  assert.deepEqual(workBackup.metadata.business,workBefore.business);assert.equal(workBackup.metadata.database,WORK_DATABASE);assert.equal(workBackup.metadata.profile,WORK_PROFILE);
  for(const [backup,used] of [[originalBackup,'4321'],[workBackup,'8765']] as const){
    const grant=backup.metadata.grants.find(g=>g.actor_id==='buyer-second')!;assert.equal(grant.revoked,true);assert.equal(grant.used_minor,used);
    const sql=spawnSync('docker',['exec','-i',dbName,'pg_restore','--file=-'],{input:backup.data,maxBuffer:16*1024*1024});assert.equal(sql.status,0);
    for(const secret of [adminPassword,appPassword,key,...(await old.query('SELECT token_hash FROM grants')).rows.map(row=>row.token_hash as string),...(await work.query('SELECT token_hash FROM grants')).rows.map(row=>row.token_hash as string)])assert.equal(sql.stdout.includes(Buffer.from(secret)),false,'Dumps exclude generated credentials and stored token hashes');
  }
  const disabled=spawnSync('docker',['exec','--env','VV_WORK_ORDER_DEMO_ENABLED=false',app,'node','dist/apps/local/src/work-snapshot.js'],{encoding:'utf8'});assert.notEqual(disabled.status,0,'Work backup cannot fall back to the legacy profile');
  for(const script of ['dist/apps/local/src/verify-restore.js','dist/apps/local/src/work-verify-restore.js'])for(const target of [LEGACY_DATABASE,WORK_DATABASE]){
    const rejected=spawnSync('docker',['exec','-i',app,'node',script,target,'--prepare-authority'],{input:JSON.stringify({database:WORK_DATABASE,profile:WORK_PROFILE,business:workBackup.metadata.business,grants:workBackup.metadata.grants}),encoding:'utf8'});
    assert.notEqual(rejected.status,0,'Restore verification cannot select either operating database');assert.match(rejected.stderr,/unique isolated restore database/);
  }
  async function restore(backup:typeof workBackup,isWork:boolean,prepare=true){
    const restoreName=`vv_restore_${randomUUID().replaceAll('-','').slice(0,24)}`;shell(`createdb -h 127.0.0.1 -U postgres ${restoreName}`);
    for(const section of ['pre-data','data'])shell(`pg_restore -h 127.0.0.1 -U postgres -d ${restoreName} --section=${section} --no-owner --no-acl --exit-on-error`,backup.data);
    shell(`psql -h 127.0.0.1 -U postgres -d ${restoreName} -v ON_ERROR_STOP=1 -c 'GRANT USAGE ON SCHEMA public TO vista_verde_app; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO vista_verde_app'`);
    const restored=connect(restoreName),script=isWork?'dist/apps/local/src/work-verify-restore.js':'dist/apps/local/src/verify-restore.js';
    const manifest={business:backup.metadata.business,grants:backup.metadata.grants,...(isWork?{database:WORK_DATABASE,profile:WORK_PROFILE}:{})};
    if(isWork){
      for(const bad of [{business:manifest.business,grants:manifest.grants},{...manifest,database:LEGACY_DATABASE},{...manifest,profile:'legacy'}]){
        const rejected=spawnSync('docker',['exec','-i',app,'node',script,restoreName,'--prepare-authority'],{input:JSON.stringify(bad),encoding:'utf8'});assert.notEqual(rejected.status,0,'Mismatched or absent profile metadata cannot prepare authority');
        assert.equal((await restored.query('SELECT count(*) FROM grants')).rows[0].count,'0');
      }
    }
    if(prepare){
      const prepared=JSON.parse(docker(['exec','-i',app,'node',script,restoreName,'--prepare-authority'],JSON.stringify(manifest)));assert.equal(prepared.prepared,true);assert.equal(prepared.credentialsRestored,false);assert.equal(prepared.grantsDisabled,true);
    }else{assert.equal(isWork,false,'Single-call restore compatibility is confined to the original schema');assert.equal((await restored.query('SELECT count(*) FROM grants')).rows[0].count,'0');}
    shell(`pg_restore -h 127.0.0.1 -U postgres -d ${restoreName} --section=post-data --no-owner --no-acl --exit-on-error`,backup.data);
    const proof=JSON.parse(docker(['exec','-i',app,'node',script,restoreName],JSON.stringify(manifest)));assert.equal(proof.verified,true);assert.equal(proof.checksum,backup.metadata.business.checksum);assert.deepEqual(proof.counts,backup.metadata.business.counts);assert.equal(proof.credentialsRestored,false);assert.equal(proof.grantsDisabled,true);
    assert.equal((await restored.query("SELECT count(*) FROM grants WHERE NOT revoked OR token_hash !~ '^disabled-restore-'")).rows[0].count,'0');assert.equal((await restored.query('SELECT count(*) FROM local_operation_state')).rows[0].count,'0');
    if(isWork){
      const specification=(await restored.query('SELECT i.specification FROM market_orders o JOIN market_items i ON i.id=o.item_id AND i.specification_revision=o.specification_revision WHERE o.id=$1',[ids.workOrderId])).rows[0].specification;assert.equal(specification.kind,'mock-print-job');assert.equal(specification.printRequirements.version,'mock-print.v1');assert.deepEqual(specification.printRequirements.mesh.bounds,[20,20,20]);
      assert.equal(proof.sourceDatabase,WORK_DATABASE);assert.equal(proof.profile,WORK_PROFILE);
      assert.deepEqual((await restored.query('SELECT quantity,reported_quantity,acknowledged_quantity,state FROM market_commitments WHERE id=$1',[ids.commitmentId])).rows,[{quantity:'8',reported_quantity:'5',acknowledged_quantity:'5',state:'in_progress'}]);
      assert.equal((await restored.query('SELECT count(*) FROM market_approvals a JOIN grants g ON g.id=a.grant_id WHERE a.proposal_id=$1 AND g.revoked',[ids.proposalId])).rows[0].count,'2');
    }else{assert.equal(proof.profile,undefined);assert.equal((await restored.query('SELECT count(*) FROM commitments WHERE id=$1',[original.commitmentId])).rows[0].count,'1');assert.equal((await restored.query("SELECT to_regclass('public.market_schema') AS marker")).rows[0].marker,null);}
  }
  await restore(originalBackup,false);await restore(workBackup,true);
  // The retained original backup tool restores a complete dump then calls its
  // verifier once. This remains compatible without a new authority-prep step.
  await restore(originalBackup,false,false);assert.deepEqual(await state(old,true),oldBefore);assert.deepEqual(await state(work),workBefore);
  const limited=localPool(`postgresql://vista_verde_app:${appPassword}@127.0.0.1:${port}/${WORK_DATABASE}`,1);pools.push(limited);await assert.rejects(()=>limited.query('DROP TABLE market_orders'),/must be owner/);
  t.diagnostic('Two owned database profiles restored exact business checksums; generated credentials excluded and historical approvals point only to disabled grants.');
});
