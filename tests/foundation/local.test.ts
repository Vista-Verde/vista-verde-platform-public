import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID,createHash } from 'node:crypto';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync,spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { localPool } from '../../packages/db/src/postgres.ts';
import { fixtureTokens,bootstrapLocal,businessSnapshot,reconcileLocal } from '../../packages/db/src/local-operations.ts';
import { draft,publication,purchase,marketProposal,marketConfirmation,marketReport,marketAcknowledgement } from '../../packages/db/src/fixtures.ts';
import { commandNames,marketCommitmentSchema,sourcingWorkspaceSchema,materialInventoryLotSchema,workStageLinkSchema } from '../../packages/contracts/src/index.ts';
import { workOrderInput,materialListingInput } from './market-helpers.ts';
import { externalDrive,validateVolume } from '../../tools/local-backup.ts';
import { ok,failure } from './helpers.ts';

test('backup identity rejects missing/wrong mount, UUID, filesystem and internal disk',() => {
  const valid={ VolumeUUID:externalDrive.uuid,MountPoint:externalDrive.path,FilesystemType:'apfs',Internal:false };
  validateVolume(valid);
  for (const value of [{},{ ...valid,VolumeUUID:randomUUID() },{ ...valid,MountPoint:'/tmp/fake-mount' },{ ...valid,FilesystemType:'hfs' },{ ...valid,Internal:true }]) assert.throws(() => validateVolume(value),/not mounted/);
});
test('fixture derivation requires a high-entropy input shape and binds stable actor identities without persisting credentials',() => {
  for (const key of ['','short','g'.repeat(64)]) assert.throws(() => fixtureTokens(key),/Invalid/);
  const key=randomBytes(32).toString('hex'),tokens=fixtureTokens(key);
  assert.equal(Object.keys(tokens).length,8); assert.equal(new Set(Object.values(tokens)).size,8);
  assert.ok(Object.values(tokens).every(token => /^[A-Za-z0-9_-]{43}$/.test(token)));
  assert.ok(JSON.stringify(tokens)===JSON.stringify(fixtureTokens(key)));
  assert.ok(JSON.stringify(tokens)!==JSON.stringify(fixtureTokens(randomBytes(32).toString('hex'))));
});
test('declarative local boundary has loopback-only sockets, no service/ingress, retained storage and exact resource limits',() => {
  const chart=readFileSync('infra/helm/vista-verde-platform/templates/statefulset.yaml','utf8');
  assert.match(chart,/listen_addresses=127\.0\.0\.1/); assert.doesNotMatch(chart,/hostNetwork:|hostPort:|kind: Service|kind: Ingress/);
  assert.match(chart,/memory: 512Mi, cpu: '1'/); assert.match(chart,/memory: 1Gi, cpu: '1'/);
  assert.match(chart,/automountServiceAccountToken: false/); assert.match(chart,/restartPolicy: Always/);
  assert.match(readFileSync('infra/helm/vista-verde-platform/templates/storage.yaml','utf8'),/reclaimPolicy: Retain/);
});

function docker(args: string[],input?: string | Buffer): string {
  const result=spawnSync('docker',args,{ encoding:'utf8',input,maxBuffer:4*1024*1024 });
  assert.equal(result.status,0,`Owned disposable Docker operation ${args[0]} succeeds`); return result.stdout.trim();
}
test('compiled persistent app and DB survive independent restarts, preserve authority/funds, gate backups and restore exact business records without credentials',async t => {
  const image=process.env.VV_LOCAL_TEST_IMAGE; assert.ok(image,'Set VV_LOCAL_TEST_IMAGE to the freshly built local ARM64 image');
  // Only the disposable test harness is portable. Live deployment still requires
  // the inspected ARM64 OrbStack context; CI never installs the Helm release.
  const ci=process.env.VV_LOCAL_TEST_ENVIRONMENT==='github-actions';
  if (ci) assert.equal(process.env.GITHUB_ACTIONS,'true','CI fixture mode requires the GitHub Actions runner');
  assert.equal(docker(['context','show']),ci ? 'default' : 'orbstack');
  assert.equal(docker(['image','inspect',image,'--format','{{.Architecture}}']),ci ? 'amd64' : 'arm64');
  const id=randomUUID(),name=`vv-local-test-${id}`,app=`${name}-app`,network=`${name}-network`,volume=`${name}-data`;
  const directory=mkdtempSync(join(tmpdir(),'vv-local-test-')); const admin=randomBytes(32).toString('hex'),password=randomBytes(32).toString('hex'),key=randomBytes(32).toString('hex');
  for (const folder of ['admin','bootstrap','app']) mkdirSync(join(directory,folder),{ mode:0o755 });
  for (const [folder,files] of Object.entries({ admin:{ 'database-password':admin },bootstrap:{ 'database-password':admin,'application-password':password,'fixture-key':key },app:{ 'database-password':password,'fixture-key':key } }))
    for (const [file,value] of Object.entries(files)) writeFileSync(join(directory,folder,file),value,{ mode:0o444 });
  let pool:ReturnType<typeof localPool> | undefined;
  t.after(async () => {
    await pool?.end();
    for (const container of [app,name,network]) spawnSync('docker',['rm','-f',container],{ stdio:'ignore' });
    spawnSync('docker',['volume','rm',volume],{ stdio:'ignore' }); rmSync(directory,{ recursive:true,force:true });
  }); // Only UUID-owned, disposable test resources; never the persistent deployment.
  docker(['volume','create','--label','vista-verde.fixture=local-persistence-test',volume]);
  // A stable disposable network holder models the Kubernetes pod namespace:
  // PostgreSQL may restart without moving the app into another network namespace.
  docker(['run','--detach','--name',network,'--label','vista-verde.fixture=local-persistence-test','--memory','64m','--cpus','0.1','--read-only','--publish','127.0.0.1::5432','--log-opt','max-size=1m','--log-opt','max-file=2',image,'node','-e','setInterval(()=>{},1000)']);
  docker(['run','--detach','--name',name,'--network',`container:${network}`,'--label','vista-verde.fixture=local-persistence-test','--memory','1g','--cpus','1','--log-opt','max-size=1m','--log-opt','max-file=2','--mount',`type=volume,source=${volume},target=/var/lib/postgresql/data`,'--mount',`type=bind,source=${join(directory,'admin')},target=/run/vista-verde,readonly`,'--env','POSTGRES_DB=vista_verde_local','--env','POSTGRES_PASSWORD_FILE=/run/vista-verde/database-password','--env','POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=scram-sha-256','postgres@sha256:5a65324fe84dc41709ff914e90b07f3e2f577073ed27bf917d4873aca0c9ec51','postgres','-c','max_connections=20','-c','shared_buffers=128MB','-c','log_min_error_statement=panic']);
  const port=docker(['port',network,'5432/tcp']).match(/127\.0\.0\.1:(\d+)/)![1]!;
  pool=localPool(`postgresql://postgres:${admin}@127.0.0.1:${port}/vista_verde_local`);
  for (let attempt=0;;attempt++) {
    try { await pool.query('SELECT 1'); break; } catch { if (attempt>=100) throw new Error('Disposable DB readiness failed'); await delay(100); }
  }
  function bootstrap() { docker(['run','--rm','--network',`container:${network}`,'--read-only','--env','VV_LOCAL_MODE=synthetic_loopback','--env','VV_DATABASE_USER=postgres','--mount',`type=bind,source=${join(directory,'bootstrap')},target=/run/vista-verde,readonly`,image!,'node','dist/apps/local/src/bootstrap.js']); }
  bootstrap();
  function start() { docker(['run','--detach','--name',app,'--label','vista-verde.fixture=local-persistence-test','--memory','512m','--cpus','1','--log-opt','max-size=1m','--log-opt','max-file=2','--network',`container:${network}`,'--read-only','--env','VV_LOCAL_MODE=synthetic_loopback','--env','NODE_OPTIONS=--max-old-space-size=256','--mount',`type=bind,source=${join(directory,'app')},target=/run/vista-verde,readonly`,image!]); }
  async function healthy() {
    for (let attempt=0;attempt<100;attempt++) {
      if (spawnSync('docker',['exec',app,'node','dist/apps/local/src/health.js','ready'],{ stdio:'ignore' }).status===0) return;
      await delay(100);
    }
    throw new Error('Compiled local app readiness failed');
  }
  // The app is never published through Docker. Requests originate on the shared
  // namespace's loopback, matching Kubernetes port-forward's destination.
  const fetchProgram=`let text='';for await(const bytes of process.stdin)text+=bytes;const input=JSON.parse(text);const response=await fetch('http://127.0.0.1:4318'+input.path,{method:input.method,headers:input.headers,...(input.body?{body:JSON.stringify(input.body)}:{})});console.log(JSON.stringify({status:response.status,headers:Object.fromEntries(response.headers),body:await response.json()}));`;
  async function browser(persona: string) {
    const call=(path: string,method: string,headers: Record<string,string>={},body?: unknown) => JSON.parse(docker(['exec','-i',app,'node','--input-type=module','-e',fetchProgram],JSON.stringify({ path,method,headers,body })));
    const boot=call('/session','GET'),cookie=boot.headers['set-cookie'].split(';')[0];
    const exchange=call('/session','POST',{ cookie,origin:'http://127.0.0.1:4318','content-type':'application/json','x-csrf-token':boot.body.csrf },{ persona });
    assert.equal(exchange.status,200); const headers={ cookie:exchange.headers['set-cookie'].split(';')[0],origin:'http://127.0.0.1:4318','content-type':'application/json','x-csrf-token':exchange.body.csrf };
    return { call:async (operation: string,input: unknown,overrides:Record<string,string>={}) => {
      const write=(commandNames as readonly string[]).includes(operation);
      const result=call(`/${write?'commands':'queries'}/${operation}`,'POST',{ ...headers,...overrides },input);
      return { status:result.status,receipt:result.body };
    } };
  }
  start(); await healthy();
  const agent=await browser('buyer-agent'),buyer=await browser('buyer'),producer=await browser('producer-a');
  const created=ok((await agent.call('createRequirementDraft',draft('persisted-local'))).receipt),requirementId=created.recordIds.requirementId!;
  ok((await buyer.call('publishRequirement',publication(requirementId,'durable-local',6000,new Date(Date.now()+86400000).toISOString()))).receipt);
  const bought=ok((await producer.call('purchaseSlot',purchase('durable-local'))).receipt);
  const proposal=ok((await agent.call('proposeMarketAllocation',marketProposal('panel-buy','panel-sell-a',8,'persisted-market-proposal'))).receipt);
  const proposalId=proposal.recordIds.proposalId!;
  const buyerConsent=marketConfirmation(proposalId,1,'persisted-market-buyer-consent');
  ok((await buyer.call('confirmMarketProposal',buyerConsent)).receipt);
  const sellerConsent=marketConfirmation(proposalId,2,'persisted-market-seller-consent');
  const goods=ok((await producer.call('confirmMarketProposal',sellerConsent)).receipt),goodsId=goods.recordIds.commitmentId!;
  const goodsReport=marketReport(goodsId,5,1,'persisted-market-five');
  const reported=ok((await producer.call('reportMarketFulfillment',goodsReport)).receipt);
  const goodsAcknowledgement=marketAcknowledgement(reported.recordIds.fulfillmentId!,1,'persisted-market-ack-five');
  const acknowledged=ok((await buyer.call('acknowledgeMarketFulfillment',goodsAcknowledgement)).receipt);
  const marketView=marketCommitmentSchema.parse(ok((await buyer.call('getMarketCommitment',{commitmentId:goodsId})).receipt).data.commitment);
  assert.equal(marketView.reportedQuantity.value,5);assert.equal(marketView.acknowledgedQuantity.value,5);assert.equal(marketView.remainingQuantity.value,3);
  assert.equal(marketView.state,'in_progress');
  const approvalReferences=(await pool.query('SELECT proposal_id,side,grant_id,actor_id FROM market_approvals ORDER BY proposal_id,side')).rows;
  assert.equal(approvalReferences.length,2);
  const inputBuyer=await browser('producer-b');
  const inputProposal=ok((await inputBuyer.call('proposeMarketAllocation',marketProposal('material-input-work-b','materialtimber-a',10,'persisted-timber-proposal',1,1,100))).receipt);
  const inputProposalId=inputProposal.recordIds.proposalId!;
  ok((await inputBuyer.call('confirmMarketProposal',marketConfirmation(inputProposalId,1,'persisted-timber-buyer-consent'))).receipt);
  const materialCommitment=ok((await producer.call('confirmMarketProposal',marketConfirmation(inputProposalId,2,'persisted-timber-seller-consent'))).receipt);
  const materialCommitmentId=materialCommitment.recordIds.commitmentId!;
  const materialReport=ok((await producer.call('reportMarketFulfillment',marketReport(materialCommitmentId,10,1,'persisted-timber-report'))).receipt);
  const materialAcknowledgement=marketAcknowledgement(materialReport.recordIds.fulfillmentId!,1,'persisted-timber-ack');
  const materialAccepted=ok((await inputBuyer.call('acknowledgeMarketFulfillment',materialAcknowledgement)).receipt);
  const acquired=materialInventoryLotSchema.parse(materialAccepted.data.lot),lotId=acquired.lotId;
  const materialUse={idempotencyKey:'persisted-use-eight',lotId,expectedRecordVersion:1,quantity:{value:8,unit:'each'},note:'Synthetic manually recorded use before restart.'};
  const materialUsed=ok((await inputBuyer.call('recordMaterialUse',materialUse)).receipt);assert.equal(materialInventoryLotSchema.parse(materialUsed.data.lot).availableQuantity.value,2);
  const leftoverInput=materialListingInput('persisted-leftover-two',2,{sourceLotId:lotId,unitPrice:{minorUnits:100,currency:'USD'}});
  const leftover=ok((await inputBuyer.call('postMaterialListing',leftoverInput)).receipt),leftoverId=leftover.recordIds.materialListingId!;
  const nextStageWork=ok((await inputBuyer.call('postWorkOrder',workOrderInput('persisted-next-stage',1,10000,{need:'A separate synthetic downstream need for manual stage navigation.'}))).receipt);
  const stageInput={idempotencyKey:'persisted-manual-stage',upstreamWorkOrderId:'material-input-work-b',downstreamWorkOrderId:nextStageWork.recordIds.workOrderId!,note:'Manual persisted stage; creates no execution or combined budget.'};
  const stage=ok((await inputBuyer.call('linkWorkStages',stageInput)).receipt),stageId=workStageLinkSchema.parse(stage.data.stageLink).linkId;
  const sourcingView=sourcingWorkspaceSchema.parse(ok((await inputBuyer.call('getSourcingWorkspace',{limit:100})).receipt).data);
  const conservedLot=sourcingView.lots.find(lot=>lot.lotId===lotId)!;assert.equal(conservedLot.usedQuantity.value,8);assert.equal(conservedLot.offeredQuantity.value,2);assert.equal(conservedLot.availableQuantity.value,0);
  const allApprovalReferences=(await pool.query('SELECT proposal_id,side,grant_id,actor_id FROM market_approvals ORDER BY proposal_id,side')).rows;assert.equal(allApprovalReferences.length,4);
  await pool.query("UPDATE grants SET revoked=true,used_minor=4321 WHERE actor_id='buyer-second'");
  const client=await pool.connect(); const before=await businessSnapshot(client); await reconcileLocal(client); client.release();
  const authority=(await pool.query('SELECT id,token_hash,revoked,used_minor,expires_at FROM grants ORDER BY id')).rows;
  docker(['restart',app]); await healthy(); bootstrap();
  const afterApp=await pool.connect(); assert.deepEqual(await businessSnapshot(afterApp),before); afterApp.release();
  assert.deepEqual((await pool.query('SELECT id,token_hash,revoked,used_minor,expires_at FROM grants ORDER BY id')).rows,authority);
  const appStarted=JSON.parse(docker(['inspect',app]))[0].State.StartedAt;
  await pool.end(); pool=undefined; docker(['restart',name]);
  pool=localPool(`postgresql://postgres:${admin}@127.0.0.1:${port}/vista_verde_local`);
  for (let attempt=0;;attempt++) { try { await pool.query('SELECT 1'); break; } catch { if (attempt>=100) throw new Error('Restarted DB readiness failed'); await delay(100); } }
  bootstrap(); await healthy();
  assert.equal(JSON.parse(docker(['inspect',app]))[0].State.StartedAt,appStarted,'DB restart does not restart the app');
  const afterDB=await pool.connect(); assert.deepEqual(await businessSnapshot(afterDB),before); afterDB.release();
  assert.deepEqual((await pool.query('SELECT id,token_hash,revoked,used_minor,expires_at FROM grants ORDER BY id')).rows,authority);
  const fresh=await browser('producer-a'); assert.deepEqual(ok((await fresh.call('purchaseSlot',purchase('durable-local'))).receipt),bought);
  const freshBuyer=await browser('buyer');
  assert.deepEqual(marketCommitmentSchema.parse(ok((await fresh.call('getMarketCommitment',{commitmentId:goodsId})).receipt).data.commitment),marketView);
  assert.deepEqual(ok((await fresh.call('confirmMarketProposal',sellerConsent)).receipt),goods);
  assert.deepEqual(ok((await fresh.call('reportMarketFulfillment',goodsReport)).receipt),reported);
  assert.deepEqual(ok((await freshBuyer.call('acknowledgeMarketFulfillment',goodsAcknowledgement)).receipt),acknowledged);
  assert.equal((await pool.query('SELECT count(*) FROM market_commitments')).rows[0].count,'2');
  assert.equal((await pool.query('SELECT count(*) FROM market_fulfillments')).rows[0].count,'2');
  const freshInputBuyer=await browser('producer-b');
  assert.deepEqual(sourcingWorkspaceSchema.parse(ok((await freshInputBuyer.call('getSourcingWorkspace',{limit:100})).receipt).data),sourcingView);
  assert.deepEqual(ok((await freshInputBuyer.call('acknowledgeMarketFulfillment',materialAcknowledgement)).receipt),materialAccepted);
  assert.deepEqual(ok((await freshInputBuyer.call('recordMaterialUse',materialUse)).receipt),materialUsed);
  assert.deepEqual(ok((await freshInputBuyer.call('postMaterialListing',leftoverInput)).receipt),leftover);
  assert.deepEqual(ok((await freshInputBuyer.call('linkWorkStages',stageInput)).receipt),stage);
  failure((await fresh.call('purchaseSlot',purchase('durable-local','different'),{ origin:'https://remote.invalid' })).receipt,'FORBIDDEN');
  await assert.rejects(() => bootstrapLocal(pool!,randomBytes(32).toString('hex')),/binding mismatch/);
  const countBefore=(await pool.query('SELECT count(*) AS n FROM accounts')).rows[0].n;
  await bootstrapLocal(pool,key); assert.equal((await pool.query('SELECT count(*) AS n FROM accounts')).rows[0].n,countBefore);
  const appInfo=JSON.parse(docker(['inspect',app]))[0],dbInfo=JSON.parse(docker(['inspect',name]))[0];
  assert.equal(appInfo.HostConfig.Memory,512*1024*1024); assert.equal(dbInfo.HostConfig.Memory,1024*1024*1024); assert.equal(appInfo.HostConfig.NanoCpus,1e9); assert.equal(dbInfo.HostConfig.NanoCpus,1e9);
  t.diagnostic(`Disposable modest-flow resource sample: ${docker(['stats','--no-stream','--format','{{json .}}',app,name])}`);
  const session=spawn('docker',['exec','-i',app,'node','dist/apps/local/src/snapshot.js'],{ stdio:['pipe','pipe','pipe'] }),exit=once(session,'exit'),lines=createInterface({ input:session.stdout });
  const [line]=await once(lines,'line'); const metadata=JSON.parse(String(line));
  assert.equal(metadata.grants.find((g: { actor_id:string;revoked:boolean;used_minor:string }) => g.actor_id==='buyer-second').revoked,true);
  assert.equal(metadata.grants.find((g: { actor_id:string;revoked:boolean;used_minor:string }) => g.actor_id==='buyer-second').used_minor,'4321');
  const blocked=await fresh.call('purchaseSlot',purchase('durable-local','while-backup')); failure(blocked.receipt,'RETRYABLE_BUSY');
  const dump=spawnSync('docker',['exec',name,'sh','-c',`export PGPASSWORD="$(cat /run/vista-verde/database-password)"; exec pg_dump -h 127.0.0.1 -U postgres -d vista_verde_local --format=custom --no-owner --no-acl --exclude-table-data=public.grants --exclude-table-data=public.local_operation_state --snapshot=${metadata.snapshot}`],{ maxBuffer:16*1024*1024 });
  assert.equal(dump.status,0); const data=dump.stdout; const digest=createHash('sha256').update(data).digest('hex');
  const corrupted=Buffer.from(data); corrupted[0]=corrupted[0]!^1; assert.notEqual(createHash('sha256').update(corrupted).digest('hex'),digest,'Corruption changes the checksum');
  session.stdin.end('finish\n'); assert.equal((await exit)[0],0); lines.close();
  const safeSQL=spawnSync('docker',['exec','-i',name,'pg_restore','--file=-'],{ input:data,maxBuffer:16*1024*1024 }); assert.equal(safeSQL.status,0);
  for (const secret of [admin,password,key,...authority.map(row => row.token_hash as string)]) assert.equal(safeSQL.stdout.includes(Buffer.from(secret)),false,'Dump excludes raw credentials and stored token hashes');
  const restore=`vv_restore_${randomUUID().replaceAll('-','').slice(0,24)}`;
  const shell=(code: string,input?: Buffer) => docker(['exec','-i',name,'sh','-c',`export PGPASSWORD="$(cat /run/vista-verde/database-password)"; ${code}`],input);
  shell(`createdb -h 127.0.0.1 -U postgres ${restore}`);
  shell(`pg_restore -h 127.0.0.1 -U postgres -d ${restore} --no-owner --no-acl --exit-on-error --section=pre-data`,data);
  shell(`pg_restore -h 127.0.0.1 -U postgres -d ${restore} --no-owner --no-acl --exit-on-error --section=data`,data);
  shell(`psql -h 127.0.0.1 -U postgres -d ${restore} -v ON_ERROR_STOP=1 -c 'GRANT USAGE ON SCHEMA public TO vista_verde_app; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO vista_verde_app'`);
  const prepared=JSON.parse(docker(['exec','-i',app,'node','dist/apps/local/src/verify-restore.js',restore,'--prepare-authority'],JSON.stringify({business:metadata.business,grants:metadata.grants})));
  assert.equal(prepared.prepared,true);assert.equal(prepared.credentialsRestored,false);assert.equal(prepared.grantsDisabled,true);
  shell(`pg_restore -h 127.0.0.1 -U postgres -d ${restore} --no-owner --no-acl --exit-on-error --section=post-data`,data);
  const proof=JSON.parse(docker(['exec','-i',app,'node','dist/apps/local/src/verify-restore.js',restore],JSON.stringify({ business:metadata.business,grants:metadata.grants })));
  assert.equal(proof.verified,true); assert.equal(proof.credentialsRestored,false); assert.equal(proof.grantsDisabled,true); assert.equal(proof.checksum,before.checksum);
  const restored=localPool(`postgresql://postgres:${admin}@127.0.0.1:${port}/${restore}`);
  assert.equal(Number((await restored.query('SELECT count(*) AS n FROM grants WHERE NOT revoked')).rows[0].n),0);
  assert.deepEqual((await restored.query('SELECT proposal_id,side,grant_id,actor_id FROM market_approvals ORDER BY proposal_id,side')).rows,allApprovalReferences);
  assert.equal((await restored.query('SELECT count(*) FROM market_approvals a JOIN grants g ON g.id=a.grant_id WHERE g.revoked')).rows[0].count,'4',
    'Restored append-only approvals retain valid references to disabled historical grants');
  const restoredCommitment=(await restored.query('SELECT quantity,reported_quantity,acknowledged_quantity,state FROM market_commitments WHERE id=$1',[goodsId])).rows[0];
  assert.deepEqual(restoredCommitment,{quantity:'8',reported_quantity:'5',acknowledged_quantity:'5',state:'in_progress'});
  assert.equal((await restored.query('SELECT allocated_quantity FROM market_orders WHERE id=$1',['panel-buy'])).rows[0].allocated_quantity,'8');
  assert.deepEqual((await restored.query('SELECT quantity,used_quantity,offered_quantity,allocated_quantity,available_quantity FROM market_inventory_lots WHERE id=$1',[lotId])).rows[0],
    {quantity:'10',used_quantity:'8',offered_quantity:'2',allocated_quantity:'0',available_quantity:'0'});
  assert.equal((await restored.query('SELECT inventory_lot_id FROM market_orders WHERE id=$1',[leftoverId])).rows[0].inventory_lot_id,lotId);
  assert.equal((await restored.query('SELECT source_fulfillment_id FROM market_inventory_lots WHERE id=$1',[lotId])).rows[0].source_fulfillment_id,materialReport.recordIds.fulfillmentId);
  assert.equal((await restored.query('SELECT count(*) FROM market_stage_links WHERE id=$1',[stageId])).rows[0].count,'1');
  await restored.end();
  const end=await pool.connect(); await reconcileLocal(end); assert.deepEqual(await businessSnapshot(end),before); end.release();
  const appRole=localPool(`postgresql://vista_verde_app:${password}@127.0.0.1:${port}/vista_verde_local`);
  await assert.rejects(() => appRole.query('DROP TABLE accounts'),/must be owner/); await appRole.end();
});
