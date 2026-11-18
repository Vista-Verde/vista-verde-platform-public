import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localPool,PostgresRepository } from '../../packages/db/src/postgres.ts';
import { Application } from '../../packages/domain/src/index.ts';
import { materialInventoryLotSchema,workStageLinkSchema,sourcingWorkspaceSchema } from '../../packages/contracts/src/market.ts';
import { fixture,ok,failure } from './helpers.ts';
import { web,browserSession,mcp } from './web-helpers.ts';
import { execute,workOrderInput,materialListingInput,responseInput,proposalInput,reportInput,acknowledgementInput,recordId,approve,commit,reportAndAcknowledge,
  getOrder,getSourcing,getCommitment,financialSnapshot,noFinancialEffects,noMutation,reconcileMarket } from './market-helpers.ts';
import type { MarketFixture } from './market-helpers.ts';

async function acquireTimber(f:MarketFixture,key='acquire-ten'){
  const commitmentId=await commit(f,proposalInput(key,'material-input-work-b','materialtimber-a',10,{unitPrice:{minorUnits:100,currency:'USD'}}),'producer-a','producer-b');
  assert.equal((await getSourcing(execute(f,'producer-b'))).lots.length,0,'An agreement alone creates no acquired inventory');
  const delivery=await reportAndAcknowledge(f,commitmentId,10,'producer-a',`${key}-delivery`,'producer-b');
  const lot=(await getSourcing(execute(f,'producer-b'))).lots.find(lot=>lot.sourceCommitmentId===commitmentId)!;assert.ok(lot);
  return {commitmentId,delivery,lot};
}

test('sourcing: raw supplier → intermediate input → component → consumer remains explicit; acquire 10, use 8 and resell leftover 2 once',async t=>{
  const f=await fixture(t),buyer=execute(f,'buyer'),a=execute(f,'producer-a'),b=execute(f,'producer-b'),finances=await financialSnapshot(f);
  const stage=(await getSourcing(b)).stageLinks.find(link=>link.linkId==='linear-stage-demo')!;
  assert.equal(stage.upstreamWorkOrderId,'material-input-work-b');assert.equal(stage.downstreamWorkOrderId,'panel-buy');assert.equal(stage.nonbinding,true);
  assert.equal((await getOrder(b,'material-input-work-b')).allocatedQuantity.value,0);assert.equal((await getOrder(buyer,'panel-buy')).allocatedQuantity.value,0);
  const {commitmentId,delivery,lot}=await acquireTimber(f);
  assert.equal(lot.quantity.value,10);assert.equal(lot.availableQuantity.value,10);assert.equal(lot.sourceLotId,'timber-lot-a');
  assert.equal(lot.sourceFulfillmentId,delivery.reported.recordIds.fulfillmentId);
  const sellerLot=(await getSourcing(a)).lots.find(lot=>lot.lotId==='timber-lot-a')!;
  assert.equal(sellerLot.quantity.value,12);assert.equal(sellerLot.offeredQuantity.value,2);assert.equal(sellerLot.allocatedQuantity.value,10);
  assert.equal(sellerLot.availableQuantity.value,0,'Delivery never reopens stock consumed by the original seller commitment');
  const use={idempotencyKey:'use-eight',lotId:lot.lotId,expectedRecordVersion:1,quantity:{value:8,unit:'each'},note:'Synthetic manual use for panel production; no recipe or quantity conversion inferred.'};
  const used=ok(await b('recordMaterialUse',use));const afterUse=materialInventoryLotSchema.parse(used.data.lot);
  assert.equal(afterUse.usedQuantity.value,8);assert.equal(afterUse.availableQuantity.value,2);assert.equal(afterUse.quantity.value,10);
  await noMutation(f,async()=>assert.deepEqual(await b('recordMaterialUse',use),used));
  const leftoverInput=materialListingInput('leftover-two',2,{sourceLotId:lot.lotId,unitPrice:{minorUnits:100,currency:'USD'},location:'Synthetic leftover shelf'});
  const leftover=ok(await b('postMaterialListing',leftoverInput)),leftoverId=recordId(leftover,'materialListingId');
  const afterOffer=(await getSourcing(b)).lots.find(value=>value.lotId===lot.lotId)!;
  assert.equal(afterOffer.usedQuantity.value,8);assert.equal(afterOffer.offeredQuantity.value,2);assert.equal(afterOffer.availableQuantity.value,0);
  await noMutation(f,async()=>assert.deepEqual(await b('postMaterialListing',leftoverInput),leftover));
  await noMutation(f,async()=>failure(await b('postMaterialListing',{...leftoverInput,idempotencyKey:'double-list-leftover'}),'INVENTORY_UNAVAILABLE'));
  const proposalId=recordId(ok(await b('respondToWorkOrder',responseInput('component-producer-response','panel-buy',8,9000))),'proposalId');
  await approve(f,proposalId,'buyer');const componentId=recordId(await approve(f,proposalId,'producer-b'),'commitmentId');
  await reportAndAcknowledge(f,componentId,8,'producer-b','component-eight');
  assert.equal((await getOrder(buyer,'panel-buy')).acknowledgedQuantity.value,8);assert.equal((await getOrder(buyer,'panel-buy')).remainingQuantity.value,4);
  assert.equal((await getOrder(b,'material-input-work-b')).acknowledgedQuantity.value,10);
  assert.equal((await getOrder(b,'material-input-work-b')).budgetCommitted?.minorUnits,1000);
  assert.equal((await getOrder(buyer,'panel-buy')).budgetCommitted?.minorUnits,72000,'Upstream budget is never added to the final work commitment');
  // A separate receiver explicitly acquires the leftover; this transfer does
  // not create a cyclic execution graph or alter the already completed stages.
  const reuseWork=recordId(ok(await a('postWorkOrder',workOrderInput('reuse-timber',2,200,{itemId:'TIMBER-DEMO',need:'Acquire two leftover demo timber pieces for another independent need.'}))),'workOrderId');
  const reused=await commit(f,proposalInput('reuse-leftover',reuseWork,leftoverId,2,{unitPrice:{minorUnits:100,currency:'USD'}}),'producer-b','producer-a');
  await reportAndAcknowledge(f,reused,2,'producer-b','reuse-two','producer-a');
  const reusedLot=(await getSourcing(a)).lots.find(value=>value.sourceCommitmentId===reused)!;assert.equal(reusedLot.availableQuantity.value,2);assert.equal(reusedLot.sourceLotId,lot.lotId);
  const conserved=(await getSourcing(b)).lots.find(value=>value.lotId===lot.lotId)!;
  assert.equal(conserved.usedQuantity.value,8);assert.equal(conserved.allocatedQuantity.value,2);assert.equal(conserved.offeredQuantity.value,0);assert.equal(conserved.availableQuantity.value,0);
  assert.equal((await getCommitment(b,commitmentId)).state,'completed');
  await noFinancialEffects(f,finances);await reconcileMarket(f);
});

test('sourcing: concurrent leftover listings cannot advertise the same two units, and report/acknowledgement replay never creates a second acquired lot',async t=>{
  const f=await fixture(t),b=execute(f,'producer-b');const {lot,delivery}=await acquireTimber(f,'race-acquisition');
  ok(await b('recordMaterialUse',{idempotencyKey:'race-use-eight',lotId:lot.lotId,expectedRecordVersion:1,quantity:{value:8,unit:'each'},note:'Synthetic use'}));
  const pool=localPool(f.connectionString);f.cleanupWith(()=>pool.end());const independent=new Application(new PostgresRepository(pool));
  const a=materialListingInput('race-leftover-a',2,{sourceLotId:lot.lotId}),c=materialListingInput('race-leftover-b',2,{sourceLotId:lot.lotId});
  const results=await Promise.all([b('postMaterialListing',a),independent.execute('postMaterialListing',c,f.context('producer-b'))]);
  assert.equal(results.filter(result=>result.ok).length,1);failure(results.find(result=>!result.ok)!,'INVENTORY_UNAVAILABLE');
  await noMutation(f,async()=>{
    assert.deepEqual(await execute(f,'producer-a')('reportMarketFulfillment',delivery.report),delivery.reported);
    assert.deepEqual(await b('acknowledgeMarketFulfillment',delivery.acknowledgement),delivery.acknowledged);
  });
  assert.equal((await f.pool.query('SELECT count(*) FROM market_inventory_lots WHERE source_fulfillment_id=$1',[delivery.reported.recordIds.fulfillmentId])).rows[0].count,'1');
  await reconcileMarket(f);
});

test('sourcing: an acknowledgement and acquired lot commit atomically; late failure creates neither a receipt nor inventory',async t=>{
  const f=await fixture(t),a=execute(f,'producer-a'),b=execute(f,'producer-b');
  const commitmentId=await commit(f,proposalInput('atomic-acquire','material-input-work-b','materialtimber-a',10,{unitPrice:{minorUnits:100,currency:'USD'}}),'producer-a','producer-b');
  const report=ok(await a('reportMarketFulfillment',reportInput('atomic-acquire-report',commitmentId,1,10)));
  const input=acknowledgementInput('atomic-acquire-ack',recordId(report,'fulfillmentId'));
  await f.pool.query("CREATE FUNCTION acquired_lot_fixture_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic acquired-lot fault'; END $$");
  await f.pool.query('CREATE TRIGGER acquired_lot_fail_outbox BEFORE INSERT ON market_outbox FOR EACH ROW EXECUTE FUNCTION acquired_lot_fixture_fault()');
  await noMutation(f,async()=>failure(await b('acknowledgeMarketFulfillment',input),'INTERNAL_ERROR'));
  assert.equal((await getSourcing(b)).lots.length,0);assert.equal((await getCommitment(b,commitmentId)).acknowledgedQuantity.value,0);
  await f.pool.query('DROP TRIGGER acquired_lot_fail_outbox ON market_outbox');const accepted=ok(await b('acknowledgeMarketFulfillment',input));
  await noMutation(f,async()=>assert.deepEqual(await b('acknowledgeMarketFulfillment',input),accepted));
  assert.equal((await getSourcing(b)).lots.length,1);assert.equal((await getSourcing(b)).lots[0]!.quantity.value,10);await reconcileMarket(f);
});

test('sourcing: PostgreSQL rejects direct quantity release or overuse even when bypassing the application',async t=>{
  const f=await fixture(t);
  await noMutation(f,()=>assert.rejects(()=>f.pool.query("UPDATE market_inventory_lots SET offered_quantity=offered_quantity-1,record_version=record_version+1 WHERE id='timber-lot-a'"),/immutable inventory origin or released quantity/));
  await noMutation(f,()=>assert.rejects(()=>f.pool.query("UPDATE market_inventory_lots SET used_quantity=13,record_version=record_version+1 WHERE id='timber-lot-a'"),/check constraint/));
  await reconcileMarket(f);
});

test('sourcing: material use checks owner, source-order scope, revision, unit, shortage and replay payload before changing private inventory',async t=>{
  const f=await fixture(t),b=execute(f,'producer-b'),{lot}=await acquireTimber(f,'bounded-acquisition');
  const input={idempotencyKey:'bounded-material-use',lotId:lot.lotId,expectedRecordVersion:1,quantity:{value:8,unit:'each'},note:'Synthetic bounded use'};
  await noMutation(f,async()=>failure(await execute(f,'buyer')('recordMaterialUse',input),'FORBIDDEN'));
  await noMutation(f,async()=>failure(await b('recordMaterialUse',{...input,quantity:{value:11,unit:'each'}}),'INVENTORY_UNAVAILABLE'));
  await noMutation(f,async()=>failure(await b('recordMaterialUse',{...input,quantity:{value:8,unit:'kg'}}),'VALIDATION_FAILED'));
  const used=ok(await b('recordMaterialUse',input));await noMutation(f,async()=>assert.deepEqual(await b('recordMaterialUse',input),used));
  await noMutation(f,async()=>failure(await b('recordMaterialUse',{...input,note:'Changed attribution'}),'IDEMPOTENCY_CONFLICT'));
  await noMutation(f,async()=>failure(await b('recordMaterialUse',{...input,idempotencyKey:'stale-use'}),'REVISION_CONFLICT'));
  await noMutation(f,async()=>failure(await b('postMaterialListing',materialListingInput('wrong-leftover-item',2,{sourceLotId:lot.lotId,itemId:'PANEL-DEMO'})),'MATCH_INVALID'));
  await f.pool.query("UPDATE grants SET market_scopes=ARRAY['material-input-work-b'] WHERE id=$1",[f.context('producer-b').grantId]);
  await noMutation(f,async()=>failure(await b('recordMaterialUse',input),'FORBIDDEN'));
  assert.equal((await getSourcing(b)).lots.some(value=>value.lotId===lot.lotId),false);
  assert.equal((await getSourcing(execute(f,'other-buyer'))).lots.some(value=>value.lotId===lot.lotId),false);
  await reconcileMarket(f);
});

test('sourcing: stage links are nonbinding, self/reciprocal/transitive cycles and unauthorized graph access cannot change work or budgets',async t=>{
  const f=await fixture(t),buyer=execute(f,'buyer');
  const ids=[];for(let i=0;i<3;i++)ids.push(recordId(ok(await buyer('postWorkOrder',workOrderInput(`stage-${i}`,1,10000))),'workOrderId'));
  const [a,b,c]=ids as [string,string,string],first={idempotencyKey:'stage-a-b',upstreamWorkOrderId:a,downstreamWorkOrderId:b,note:'Manual illustrative stage; no automatic execution.'};
  const before=await Promise.all(ids.map(id=>getOrder(buyer,id)));const linked=ok(await buyer('linkWorkStages',first));assert.equal(workStageLinkSchema.parse(linked.data.stageLink).nonbinding,true);
  ok(await buyer('linkWorkStages',{idempotencyKey:'stage-b-c',upstreamWorkOrderId:b,downstreamWorkOrderId:c,note:'Manual subsequent stage'}));
  await noMutation(f,async()=>assert.deepEqual(await buyer('linkWorkStages',first),linked));
  for(const [upstream,downstream,key,code] of [[a,a,'self','VALIDATION_FAILED'],[b,a,'reciprocal','MATCH_INVALID'],[c,a,'transitive-cycle','MATCH_INVALID']] as const){
    await noMutation(f,async()=>failure(await buyer('linkWorkStages',{idempotencyKey:key,upstreamWorkOrderId:upstream,downstreamWorkOrderId:downstream,note:'Blocked graph link'}),code));
  }
  await noMutation(f,async()=>failure(await execute(f,'other-buyer')('linkWorkStages',{...first,idempotencyKey:'foreign-stage'}),'FORBIDDEN'));
  assert.deepEqual(await Promise.all(ids.map(id=>getOrder(buyer,id))),before);assert.equal((await f.pool.query('SELECT count(*) FROM market_commitments')).rows[0].count,'0');
  await f.pool.query('UPDATE grants SET market_scopes=$1 WHERE id=$2',[[a],f.context('buyer').grantId]);
  await noMutation(f,async()=>failure(await buyer('linkWorkStages',first),'FORBIDDEN'));
  assert.equal((await getSourcing(buyer)).stageLinks.some(link=>link.linkId===linked.recordIds.stageLinkId),false);await reconcileMarket(f);
});

test('sourcing: concurrent opposite stage links from independent organizations/connections create exactly one acyclic edge',async t=>{
  const f=await fixture(t),a=execute(f,'producer-a'),b=execute(f,'producer-b');
  const upstream=recordId(ok(await a('postWorkOrder',workOrderInput('graph-race-a',1,10000))),'workOrderId');
  const downstream=recordId(ok(await b('postWorkOrder',workOrderInput('graph-race-b',1,10000))),'workOrderId');
  const poolA=localPool(f.connectionString),poolB=localPool(f.connectionString);f.cleanupWith(()=>poolA.end());f.cleanupWith(()=>poolB.end());
  const pids=await Promise.all([poolA.query('SELECT pg_backend_pid() AS pid'),poolB.query('SELECT pg_backend_pid() AS pid')]);assert.notEqual(pids[0]!.rows[0].pid,pids[1]!.rows[0].pid);
  const processA=new Application(new PostgresRepository(poolA)),processB=new Application(new PostgresRepository(poolB));
  let start!:()=>void;const barrier=new Promise<void>(resolve=>{start=resolve;});
  const inputA={idempotencyKey:'graph-opposite-a',upstreamWorkOrderId:upstream,downstreamWorkOrderId:downstream,note:'Manual cross-organization stage A to B.'};
  const inputB={idempotencyKey:'graph-opposite-b',upstreamWorkOrderId:downstream,downstreamWorkOrderId:upstream,note:'Competing manual cross-organization stage B to A.'};
  const pending=[(async()=>{await barrier;return processA.execute('linkWorkStages',inputA,f.context('producer-a'));})(),
    (async()=>{await barrier;return processB.execute('linkWorkStages',inputB,f.context('producer-b'));})()];
  start();const results=await Promise.all(pending);assert.equal(results.filter(result=>result.ok).length,1);failure(results.find(result=>!result.ok)!,'MATCH_INVALID');
  assert.equal((await f.pool.query('SELECT count(*) FROM market_stage_links WHERE upstream_work_order_id=ANY($1::text[]) AND downstream_work_order_id=ANY($1::text[])',[[upstream,downstream]])).rows[0].count,'1');
  const cycles=await f.pool.query(`WITH RECURSIVE paths(origin,next,visited) AS (
    SELECT upstream_work_order_id,downstream_work_order_id,ARRAY[upstream_work_order_id] FROM market_stage_links
    UNION ALL SELECT p.origin,l.downstream_work_order_id,p.visited||p.next FROM paths p JOIN market_stage_links l ON l.upstream_work_order_id=p.next
    WHERE NOT p.next=ANY(p.visited)) SELECT 1 FROM paths WHERE origin=next`);
  assert.equal(cycles.rowCount,0,'The persisted graph has no cycle after competing inverse links');
  assert.equal((await getOrder(a,upstream)).allocatedQuantity.value,0);assert.equal((await getOrder(b,downstream)).budgetCommitted?.minorUnits,0);await reconcileMarket(f);
});

test('sourcing: an outbox failure rolls back acquired inventory, material use, leftover publication and stage links with safe same-key recovery',async t=>{
  const f=await fixture(t),b=execute(f,'producer-b');const {lot}=await acquireTimber(f,'fault-acquisition');
  await f.pool.query("CREATE FUNCTION sourcing_fixture_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic sourcing fault'; END $$");
  const inject=()=>f.pool.query('CREATE TRIGGER sourcing_fail_outbox BEFORE INSERT ON market_outbox FOR EACH ROW EXECUTE FUNCTION sourcing_fixture_fault()');
  const remove=()=>f.pool.query('DROP TRIGGER sourcing_fail_outbox ON market_outbox');
  const input={idempotencyKey:'fault-use',lotId:lot.lotId,expectedRecordVersion:1,quantity:{value:8,unit:'each'},note:'Synthetic use'};
  await inject();await noMutation(f,async()=>failure(await b('recordMaterialUse',input),'INTERNAL_ERROR'));await remove();ok(await b('recordMaterialUse',input));
  const leftover=materialListingInput('fault-leftover',2,{sourceLotId:lot.lotId});await inject();
  await noMutation(f,async()=>failure(await b('postMaterialListing',leftover),'INTERNAL_ERROR'));await remove();ok(await b('postMaterialListing',leftover));
  const workId=recordId(ok(await b('postWorkOrder',workOrderInput('fault-stage-work',1,10000))),'workOrderId');
  const stage={idempotencyKey:'fault-stage-link',upstreamWorkOrderId:'material-input-work-b',downstreamWorkOrderId:workId,note:'Manual fault fixture stage'};
  await inject();await noMutation(f,async()=>failure(await b('linkWorkStages',stage),'INTERNAL_ERROR'));await remove();ok(await b('linkWorkStages',stage));
  await reconcileMarket(f);
});

test('sourcing adapters: acknowledged material transfer, use, leftover and graph views share persisted MCP/HTTP identities',async t=>{
  const f=await fixture(t),api=await web(f),a=await mcp(f,'producer-a'),b=await mcp(f,'producer-b'),browser=await browserSession(api.url,'producer-b');
  const {lot}=await acquireTimber(f,'adapter-acquisition');
  const used=ok((await browser.call('recordMaterialUse',{idempotencyKey:'http-use',lotId:lot.lotId,expectedRecordVersion:1,quantity:{value:8,unit:'each'},note:'Synthetic HTTP material use'})).receipt);
  assert.equal(materialInventoryLotSchema.parse(used.data.lot).availableQuantity.value,2);
  const leftoverId=recordId(ok(await b.call('postMaterialListing',materialListingInput('sdk-leftover',2,{sourceLotId:lot.lotId}))),'materialListingId');
  assert.equal((await getOrder(a.call,leftoverId)).sourceLotId,lot.lotId);
  assert.deepEqual((await browser.call('getSourcingWorkspace',{limit:100})).receipt,await b.call('getSourcingWorkspace',{limit:100}));
  const publicLots=sourcingWorkspaceSchema.parse(ok(await a.call('getSourcingWorkspace',{limit:100})).data);assert.equal(publicLots.lots.some(value=>value.lotId===lot.lotId),false);
  await reconcileMarket(f);
});
