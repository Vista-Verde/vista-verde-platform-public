import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localPool,PostgresRepository } from '../../packages/db/src/postgres.ts';
import { Application } from '../../packages/domain/src/index.ts';
import { marketOrderListSchema,marketOrderDetailSchema,marketItemDetailSchema,materialSourceLinkSchema,marketWorkspaceSchema } from '../../packages/contracts/src/market.ts';
import { fixture,ok,failure } from './helpers.ts';
import { web,browserSession,mcp } from './web-helpers.ts';
import { execute,workOrderInput,materialListingInput,responseInput,confirmationInput,recordId,approve,
  getOrder,getProposal,getCommitment,reportAndAcknowledge,financialSnapshot,noFinancialEffects,noMutation,reconcileMarket } from './market-helpers.ts';

test('work orders: concrete need, total budget and materials are independent; a producer responds without publishing a listing or approving terms',async t=>{
  const f=await fixture(t),buyer=execute(f,'buyer'),producer=execute(f,'producer-a'),finances=await financialSnapshot(f);
  const input=workOrderInput('concrete-need',12,120000,{need:'Produce 12 illustrative panels for the demo receiving site.'});
  const workId=recordId(ok(await execute(f,'buyer-agent')('postWorkOrder',input)),'workOrderId');
  const work=await getOrder(buyer,workId);
  assert.equal(work.kind,'work_order');assert.equal(work.need,input.need);assert.deepEqual(work.budget,input.budget);
  assert.equal(work.budgetCommitted?.minorUnits,0);assert.equal(work.remainingBudget?.minorUnits,120000);
  const materialsBefore=marketOrderListSchema.parse(ok(await buyer('listMaterialListings',{limit:100})).data);
  const response=responseInput('private-production-response',workId,8,9000,{terms:'PRIVATE CAPACITY TERMS FOR THIS WORK ORDER'});
  const proposed=ok(await producer('respondToWorkOrder',response)),proposalId=recordId(proposed,'proposalId'),capacityId=recordId(proposed,'sellOrderId');
  const capacity=await getOrder(producer,capacityId);assert.equal(capacity.kind,'capacity_offer');assert.equal(capacity.linkedWorkOrderId,workId);
  assert.equal(capacity.budget,null);assert.equal(capacity.need,null);
  const proposal=await getProposal(buyer,proposalId);assert.equal(proposal.buyerApproved,false);assert.equal(proposal.sellerApproved,false);
  assert.equal((await getOrder(buyer,workId)).remainingQuantity.value,12);assert.equal((await getOrder(buyer,workId)).remainingBudget?.minorUnits,120000);
  assert.deepEqual(marketOrderListSchema.parse(ok(await buyer('listMaterialListings',{limit:100})).data),materialsBefore);
  const publicBook=marketItemDetailSchema.parse(ok(await execute(f,'producer-b')('getMarketItem',{itemId:'PANEL-DEMO',limit:100})).data);
  assert.equal(publicBook.sellOrders.some(order=>order.orderId===capacityId),false);
  assert.equal(JSON.stringify(publicBook).includes(response.terms),false);
  await noMutation(f,async()=>failure(await execute(f,'producer-b')('getMarketOrder',{orderId:capacityId}),'FORBIDDEN'));
  await noMutation(f,async()=>failure(await execute(f,'buyer-agent')('confirmMarketProposal',confirmationInput('agent-consent-denied',proposalId,1)),'FORBIDDEN'));
  await approve(f,proposalId,'producer-a');assert.equal((await getOrder(buyer,workId)).budgetCommitted?.minorUnits,0);
  const commitmentId=recordId(await approve(f,proposalId,'buyer'),'commitmentId');
  assert.equal((await getOrder(buyer,workId)).budgetCommitted?.minorUnits,72000);
  assert.equal((await getOrder(buyer,workId)).remainingBudget?.minorUnits,48000);
  await reportAndAcknowledge(f,commitmentId,5,'producer-a','new-work-five');
  assert.equal((await getCommitment(buyer,commitmentId)).remainingQuantity.value,3);
  assert.equal((await getOrder(buyer,workId)).remainingQuantity.value,4);
  await noFinancialEffects(f,finances);await reconcileMarket(f);
});

test('work orders: two independent connections race a stated budget while quantity is sufficient for both, and exactly one allocation fits',async t=>{
  const f=await fixture(t),buyer=execute(f,'buyer'),finances=await financialSnapshot(f),poolA=localPool(f.connectionString),poolB=localPool(f.connectionString);
  f.cleanupWith(()=>poolA.end());f.cleanupWith(()=>poolB.end());
  const pids=await Promise.all([poolA.query('SELECT pg_backend_pid() AS pid'),poolB.query('SELECT pg_backend_pid() AS pid')]);assert.notEqual(pids[0]!.rows[0].pid,pids[1]!.rows[0].pid);
  const a=new Application(new PostgresRepository(poolA)),b=new Application(new PostgresRepository(poolB));
  for(let round=0;round<4;round++){
    const workId=recordId(ok(await buyer('postWorkOrder',workOrderInput(`budget-race-${round}`,6,50000))),'workOrderId');
    const pA=recordId(ok(await execute(f,'producer-a')('respondToWorkOrder',responseInput(`budget-response-a-${round}`,workId,3,15000))),'proposalId');
    const pB=recordId(ok(await execute(f,'producer-b')('respondToWorkOrder',responseInput(`budget-response-b-${round}`,workId,3,15000))),'proposalId');
    await approve(f,pA,'buyer');await approve(f,pB,'buyer');
    const inputA=confirmationInput(`budget-final-a-${round}`,pA,2),inputB=confirmationInput(`budget-final-b-${round}`,pB,2);
    const replies=await Promise.all([a.execute('confirmMarketProposal',inputA,f.context('producer-a')),b.execute('confirmMarketProposal',inputB,f.context('producer-b'))]);
    assert.equal(replies.filter(receipt=>receipt.ok).length,1);failure(replies.find(receipt=>!receipt.ok)!,'BUDGET_EXCEEDED');
    const work=await getOrder(buyer,workId);assert.equal(work.remainingQuantity.value,3,'The losing response still fits the quantity ceiling');
    assert.equal(work.budgetCommitted?.minorUnits,45000);assert.equal(work.remainingBudget?.minorUnits,5000);
    const winner=replies[0]!.ok ? 'producer-a' : 'producer-b',commitmentId=recordId(ok(replies.find(receipt=>receipt.ok)!),'commitmentId');
    await reportAndAcknowledge(f,commitmentId,3,winner,`budget-complete-${round}`);
    assert.equal((await getOrder(buyer,workId)).budgetCommitted?.minorUnits,45000,'Completion never restores consumed stated budget');
    await reconcileMarket(f);
  }
  await noFinancialEffects(f,finances);
});

test('work orders: expensive proposals remain nonbinding; zero/insufficient total budgets block final agreement without changing consent or quantities',async t=>{
  const f=await fixture(t),buyer=execute(f,'buyer');
  for(const budget of [0,8999]){
    const workId=recordId(ok(await buyer('postWorkOrder',workOrderInput(`insufficient-budget-${budget}`,1,budget))),'workOrderId');
    const proposalId=recordId(ok(await execute(f,'producer-a')('respondToWorkOrder',responseInput(`expensive-response-${budget}`,workId,1,9000))),'proposalId');
    assert.equal((await getOrder(buyer,workId)).budgetCommitted?.minorUnits,0);
    await approve(f,proposalId,'buyer');
    await noMutation(f,async()=>failure(await execute(f,'producer-a')('confirmMarketProposal',confirmationInput(`expensive-final-${budget}`,proposalId,2)),'BUDGET_EXCEEDED'));
    assert.equal((await getOrder(buyer,workId)).allocatedQuantity.value,0);
  }
  await reconcileMarket(f);
});

test('work orders: source candidates can reference another material item but reserve neither material, work quantity nor budget',async t=>{
  const f=await fixture(t),buyer=execute(f,'buyer'),producer=execute(f,'producer-a'),finances=await financialSnapshot(f);
  const workId=recordId(ok(await buyer('postWorkOrder',workOrderInput('source-work'))),'workOrderId');
  const materialId=recordId(ok(await execute(f,'producer-b')('postMaterialListing',materialListingInput('source-material'))),'materialListingId');
  const beforeMaterial=await getOrder(buyer,materialId),beforeWork=await getOrder(buyer,workId);
  const input={idempotencyKey:'candidate-source',workOrderId:workId,materialListingId:materialId,quantity:{value:8,unit:'each'},note:'Candidate timber for panel production; no equivalence or purchase implied.'};
  await noMutation(f,async()=>failure(await producer('linkMaterialSource',input),'FORBIDDEN'));
  const linked=ok(await buyer('linkMaterialSource',input)),source=materialSourceLinkSchema.parse(linked.data.materialSourceLink);
  assert.equal(source.nonbinding,true);assert.equal(source.workOrderId,workId);assert.equal(source.materialListingId,materialId);
  assert.deepEqual(await getOrder(buyer,materialId),beforeMaterial);assert.deepEqual(await getOrder(buyer,workId),beforeWork);
  await noMutation(f,async()=>assert.deepEqual(await buyer('linkMaterialSource',input),linked));
  await noMutation(f,async()=>failure(await buyer('linkMaterialSource',{...input,quantity:{value:7,unit:'each'}}),'IDEMPOTENCY_CONFLICT'));
  const detail=marketOrderDetailSchema.parse(ok(await buyer('getMarketOrder',{orderId:workId})).data);assert.equal(detail.materialSourceLinks.length,1);
  const foreignDetail=marketOrderDetailSchema.parse(ok(await execute(f,'other-buyer')('getMarketOrder',{orderId:workId})).data);assert.deepEqual(foreignDetail.materialSourceLinks,[]);
  const proposalId=recordId(ok(await producer('respondToWorkOrder',responseInput('source-producer-response',workId))),'proposalId');
  const privateNote='PRIVATE PRODUCER A MATERIAL SOURCE NOTE';
  const producerLink=ok(await producer('linkMaterialSource',{...input,idempotencyKey:'responding-producer-source',note:privateNote}));
  const producerSources=marketOrderDetailSchema.parse(ok(await producer('getMarketOrder',{orderId:workId})).data).materialSourceLinks;
  assert.equal(producerSources.length,1);assert.equal(producerSources[0]!.actorId,'producer-a');
  assert.equal(marketOrderDetailSchema.parse(ok(await buyer('getMarketOrder',{orderId:workId})).data).materialSourceLinks.length,2);
  const rival=execute(f,'producer-b');ok(await rival('respondToWorkOrder',responseInput('rival-private-source-response',workId,4,9500)));
  const rivalDetail=marketOrderDetailSchema.parse(ok(await rival('getMarketOrder',{orderId:workId})).data);
  assert.deepEqual(rivalDetail.materialSourceLinks,[],'Responding to a work order does not reveal another producer’s private candidates');
  for(const privateValue of [privateNote,recordId(producerLink,'linkId')])assert.equal(JSON.stringify(rivalDetail).includes(privateValue),false);
  await noMutation(f,async()=>failure(await rival('getMarketAudit',{recordId:recordId(producerLink,'linkId'),limit:100}),'FORBIDDEN'));
  assert.equal((await getProposal(buyer,proposalId)).buyerApproved,false);
  await noFinancialEffects(f,finances);await reconcileMarket(f);
});

test('work orders: scope-derived private capacity and replay remain bound to the linked work order and current explicit authority',async t=>{
  const f=await fixture(t),buyer=execute(f,'buyer'),seller=execute(f,'producer-a');
  const workId=recordId(ok(await buyer('postWorkOrder',workOrderInput('narrow-work'))),'workOrderId');
  await f.pool.query('UPDATE grants SET market_scopes=$1 WHERE id=ANY($2::text[])',[[workId],[f.context('buyer').grantId,f.context('producer-a').grantId]]);
  const input=responseInput('narrow-response',workId),response=ok(await seller('respondToWorkOrder',input)),capacityId=recordId(response,'sellOrderId'),proposalId=recordId(response,'proposalId');
  assert.equal((await getOrder(buyer,capacityId)).linkedWorkOrderId,workId);assert.equal((await getOrder(seller,capacityId)).linkedWorkOrderId,workId);
  await noMutation(f,async()=>assert.deepEqual(await seller('respondToWorkOrder',input),response));
  await noMutation(f,async()=>failure(await seller('respondToWorkOrder',{...input,unitPrice:{minorUnits:8000,currency:'USD'}}),'IDEMPOTENCY_CONFLICT'));
  await approve(f,proposalId,'buyer');await f.pool.query('UPDATE grants SET revoked=true WHERE id=$1',[f.context('buyer').grantId]);
  await noMutation(f,async()=>failure(await seller('confirmMarketProposal',confirmationInput('narrow-final-denied',proposalId,2)),'FORBIDDEN'));
  await f.pool.query('UPDATE grants SET market_scopes=ARRAY[]::text[] WHERE id=$1',[f.context('producer-a').grantId]);
  await noMutation(f,async()=>failure(await seller('respondToWorkOrder',input),'FORBIDDEN'));
  await reconcileMarket(f);
});

test('work orders: a late outbox failure rolls back posting, material listing, private capacity/proposal and source link atomically',async t=>{
  const f=await fixture(t),buyer=execute(f,'buyer'),seller=execute(f,'producer-a');
  const workId=recordId(ok(await buyer('postWorkOrder',workOrderInput('fault-source-work'))),'workOrderId');
  const materialId=recordId(ok(await seller('postMaterialListing',materialListingInput('fault-source-material'))),'materialListingId');
  await f.pool.query("CREATE FUNCTION work_fixture_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic work fault'; END $$");
  await f.pool.query('CREATE TRIGGER work_fail_outbox BEFORE INSERT ON market_outbox FOR EACH ROW EXECUTE FUNCTION work_fixture_fault()');
  for(const [operation,input,actor] of [
    ['postWorkOrder',workOrderInput('rollback-work'),'buyer'],['postMaterialListing',materialListingInput('rollback-material'),'producer-a'],
    ['respondToWorkOrder',responseInput('rollback-capacity',workId),'producer-a'],
    ['linkMaterialSource',{idempotencyKey:'rollback-source',workOrderId:workId,materialListingId:materialId,quantity:{value:1,unit:'each'},note:'Manual synthetic candidate'},'buyer']
  ] as const)await noMutation(f,async()=>failure(await execute(f,actor)(operation,input),'INTERNAL_ERROR'));
  await f.pool.query('DROP TRIGGER work_fail_outbox ON market_outbox');
  const saved=ok(await seller('respondToWorkOrder',responseInput('rollback-capacity',workId)));
  assert.ok(saved.recordIds.proposalId);assert.equal((await f.pool.query("SELECT count(*) FROM market_orders WHERE kind='capacity_offer'")).rows[0].count,'1');await reconcileMarket(f);
});

test('work order adapters: MCP posting and browser response/consent/source links use the same persisted records and public boards',async t=>{
  const f=await fixture(t),api=await web(f),agent=await mcp(f,'buyer-agent'),buyer=await browserSession(api.url,'buyer'),producer=await mcp(f,'producer-a');
  const input=workOrderInput('sdk-concrete-work'),workId=recordId(ok(await agent.call('postWorkOrder',input)),'workOrderId');
  const materialId=recordId(ok(await producer.call('postMaterialListing',materialListingInput('sdk-independent-material'))),'materialListingId');
  const seller=await browserSession(api.url,'producer-a'),proposed=ok((await seller.call('respondToWorkOrder',responseInput('http-producer-response',workId))).receipt),proposalId=recordId(proposed,'proposalId');
  const linked=ok((await buyer.call('linkMaterialSource',{idempotencyKey:'http-source',workOrderId:workId,materialListingId:materialId,quantity:{value:8,unit:'each'},note:'Nonbinding timber candidate.'})).receipt);
  assert.equal(materialSourceLinkSchema.parse(linked.data.materialSourceLink).nonbinding,true);
  ok((await buyer.call('confirmMarketProposal',confirmationInput('http-work-buyer-consent',proposalId,1))).receipt);
  const commitmentId=recordId(ok(await producer.call('confirmMarketProposal',confirmationInput('sdk-work-seller-consent',proposalId,2))),'commitmentId');
  for(const [operation,input] of [['listWorkOrders',{search:'Produce'}],['listMaterialListings',{search:'timber'}],
    ['getMarketOrder',{orderId:workId}],['getMarketProposal',{proposalId}],['getMarketCommitment',{commitmentId}]] as const){
    assert.deepEqual((await seller.call(operation,input)).receipt,await producer.call(operation,input));
  }
  assert.equal((await getOrder(producer.call,workId)).budgetCommitted?.minorUnits,72000);await reconcileMarket(f);
});

test('work detail: scoped workspace pages all related records despite 150 unrelated orders and never reveals rival responses',async t=>{
  const f=await fixture(t),buyer=execute(f,'buyer'),seller=execute(f,'producer-a'),rival=execute(f,'producer-b');
  const workId=recordId(ok(await buyer('postWorkOrder',workOrderInput('scoped-target',2,10000))),'workOrderId');
  const proposalId=recordId(ok(await seller('respondToWorkOrder',responseInput('scoped-response',workId,2,3000))),'proposalId');
  await approve(f,proposalId,'producer-a');const commitmentId=recordId(await approve(f,proposalId,'buyer'),'commitmentId');
  for(let i=0;i<150;i++)ok(await buyer('postWorkOrder',workOrderInput(`unrelated-${i}`,1,10000)));
  const api=await web(f),http=await browserSession(api.url,'buyer'),agent=await mcp(f,'buyer');
  const scoped=ok((await http.call('getMarketWorkspace',{workOrderId:workId,limit:100})).receipt);
  assert.deepEqual(scoped,ok(await agent.call('getMarketWorkspace',{workOrderId:workId,limit:100})));
  const data=marketWorkspaceSchema.parse(scoped.data);assert.equal(data.orders.length,1);assert.equal(data.proposals[0]?.proposalId,proposalId);assert.equal(data.commitments[0]?.commitmentId,commitmentId);
  const hidden=marketWorkspaceSchema.parse(ok(await rival('getMarketWorkspace',{workOrderId:workId,limit:100})).data);
  assert.deepEqual(hidden.proposals,[]);assert.deepEqual(hidden.commitments,[]);
  const manyId=recordId(ok(await buyer('postWorkOrder',workOrderInput('many-related',200,1000000))),'workOrderId');
  for(let i=0;i<105;i++)ok(await seller('respondToWorkOrder',responseInput(`related-${i}`,manyId,1,3000)));
  const ids=new Set<string>();let cursor:string|undefined;
  do{const page=marketWorkspaceSchema.parse(ok(await buyer('getMarketWorkspace',{workOrderId:manyId,limit:20,...(cursor?{cursor}:{})})).data);for(const p of page.proposals){assert.equal(p.buyOrderId,manyId);assert.equal(ids.has(p.proposalId),false);ids.add(p.proposalId);}cursor=page.nextCursor??undefined;}while(cursor);
  assert.equal(ids.size,105);
  await noMutation(f,async()=>failure(await buyer('getMarketWorkspace',{workOrderId:'unknown-work',limit:100}),'FORBIDDEN'));
  await f.pool.query('UPDATE grants SET market_scopes=$1 WHERE id=$2',[['unrelated-id'],f.context('buyer').grantId]);
  await noMutation(f,async()=>failure(await buyer('getMarketWorkspace',{workOrderId:workId,limit:100}),'FORBIDDEN'));
  await reconcileMarket(f);
});

test('persistent print: immutable versioned metadata is created only by explicit work; real SDK and HTTP share consent, retries and receipt',async t=>{
  const f=await fixture(t),finances=await financialSnapshot(f),api=await web(f),http=await browserSession(api.url,'buyer'),agent=await mcp(f,'buyer-agent'),printer=await mcp(f,'producer-a');
  const requirements={version:'mock-print.v1',profile:'FDM-PETG-175-BLACK-SYNTH',mesh:{format:'binary',triangles:12,bounds:[20,20,20],units:'mm',synthetic:true},materialResponsibility:'producer',delivery:{mode:'mock_courier',zone:'A',allowance:{minorUnits:1000,currency:'USD'}}};
  const input={...workOrderInput('persistent-print',1,3000),itemId:'PRINT-JOB-SYNTH',printRequirements:requirements,need:'One fictional small print',availableAt:new Date().toISOString(),deliveryBy:new Date(Date.now()+7*86400000).toISOString()};
  const before=await f.pool.query('SELECT count(*) FROM market_items');
  const posted=ok(await agent.call('postWorkOrder',input)),workId=recordId(posted,'workOrderId');
  const itemId=recordId(posted,'itemId');assert.match(itemId,/^PRINT-/);assert.notEqual(itemId,input.itemId);
  assert.deepEqual((await getOrder(async(op,v)=>(await http.call(op,v)).receipt,workId)).printRequirements,requirements);
  await noMutation(f,async()=>assert.deepEqual(await agent.call('postWorkOrder',input),posted));
  assert.equal(Number((await f.pool.query('SELECT count(*) FROM market_items')).rows[0].count),Number(before.rows[0].count)+1);
  await noMutation(f,async()=>failure(await agent.call('postWorkOrder',{...input,printRequirements:{...requirements,materialResponsibility:'customer'}}),'IDEMPOTENCY_CONFLICT'));
  await noMutation(f,async()=>failure(await execute(f,'buyer-agent')('postWorkOrder',{...input,idempotencyKey:'filename-rejected',printRequirements:{...requirements,filename:'PRIVATE.stl'}}),'VALIDATION_FAILED'));
  const p=ok(await printer.call('respondToWorkOrder',responseInput('print-response-persisted',workId,1,3000))),proposalId=recordId(p,'proposalId');
  await approve(f,proposalId,'buyer');const commitmentId=recordId(await approve(f,proposalId,'producer-a'),'commitmentId');
  assert.deepEqual((await getCommitment(execute(f,'buyer'),commitmentId)).buyOrderSnapshot.printRequirements,requirements);
  await reportAndAcknowledge(f,commitmentId,1,'producer-a','persisted-print-receipt');
  assert.equal((await getCommitment(execute(f,'buyer'),commitmentId)).state,'completed');
  const list=marketOrderListSchema.parse(ok(await execute(f,'buyer')('listWorkOrders',{printOnly:true,limit:100})).data);assert.equal(list.orders.length,1);assert.equal(list.orders[0]?.orderId,workId);
  const customer=recordId(ok(await execute(f,'buyer')('postWorkOrder',{...input,idempotencyKey:'customer-print',printRequirements:{...requirements,materialResponsibility:'customer'}})),'workOrderId');
  await noMutation(f,async()=>failure(await printer.call('respondToWorkOrder',responseInput('material-not-accepted',customer,1,2600)),'MATCH_INVALID'));
  const acceptedInput={...responseInput('material-accepted',customer,1,2600),acceptCustomerMaterial:true,terms:'x'.repeat(1900)};
  const accepted=ok(await printer.call('respondToWorkOrder',acceptedInput));
  await noMutation(f,async()=>assert.deepEqual(ok(await printer.call('respondToWorkOrder',acceptedInput)),accepted));
  assert.match((await getProposal(execute(f,'buyer'),recordId(accepted,'proposalId'))).sellOrderSnapshot.terms,/Producer explicitly accepts/);
  await noMutation(f,async()=>failure(await execute(f,'producer-a')('respondToWorkOrder',{...acceptedInput,idempotencyKey:'overlong-accept',terms:'x'.repeat(1901)}),'VALIDATION_FAILED'));
  await noMutation(f,async()=>failure(await execute(f,'buyer')('postWorkOrder',{...workOrderInput('duplicate-print-spec',20,100000),itemId}),'MATCH_INVALID'));
  const listing=recordId(ok(await execute(f,'producer-b')('postMaterialListing',materialListingInput('generic-print-listing',1,{itemId:recordId(ok(await execute(f,'buyer')('getMarketOrder',{orderId:customer})),'itemId')}))),'materialListingId');
  const customerOrder=await getOrder(execute(f,'buyer'),customer),supply=await getOrder(execute(f,'buyer'),listing);
  await noMutation(f,async()=>failure(await execute(f,'buyer')('proposeMarketAllocation',{idempotencyKey:'bypass-customer',buyOrderId:customer,sellOrderId:listing,expectedBuyVersion:customerOrder.recordVersion,expectedSellVersion:supply.recordVersion,quantity:{value:1,unit:'each'},unitPrice:{minorUnits:2600,currency:'USD'},expiresAt:new Date(Date.now()+3600000).toISOString()}),'MATCH_INVALID'));
  await noFinancialEffects(f,finances);await reconcileMarket(f);
});

test('print attention keeps receipt/fulfillment ahead of stale alternatives and scopes private approval counts',async t=>{
 const f=await fixture(t),buyer=execute(f,'buyer'),producer=execute(f,'producer-a');
 const requirements={version:'mock-print.v1',profile:'FDM-PETG-175-BLACK-SYNTH',mesh:{format:'binary',triangles:12,bounds:[20,20,20],units:'mm',synthetic:true},materialResponsibility:'producer',delivery:{mode:'mock_courier',zone:'A',allowance:{minorUnits:1000,currency:'USD'}}};
 const id=recordId(ok(await buyer('postWorkOrder',{...workOrderInput('attention-print',1,3000),itemId:'PRINT-JOB-SYNTH',printRequirements:requirements,availableAt:new Date().toISOString(),deliveryBy:new Date(Date.now()+7*86400000).toISOString()})),'workOrderId');
 const p=recordId(ok(await producer('respondToWorkOrder',responseInput('attention-one',id,1,3000))),'proposalId');ok(await execute(f,'producer-b')('respondToWorkOrder',responseInput('attention-other',id,1,2900)));
 const attention=async(actor:string)=>marketOrderListSchema.parse(ok(await execute(f,actor)('listWorkOrders',{printOnly:true,limit:100})).data).orders.find(o=>o.orderId===id)!.attention!;
 assert.equal((await attention('buyer-agent')).status,'authorization_needed');assert.equal((await attention('buyer')).approvalCount,2);assert.equal((await attention('other-buyer')).approvalCount,0);
 await approve(f,p,'buyer');const c=recordId(await approve(f,p,'producer-a'),'commitmentId');assert.equal((await attention('buyer')).status,'fulfillment');
 const report=ok(await producer('reportMarketFulfillment',{idempotencyKey:'attention-report',commitmentId:c,expectedRecordVersion:1,quantity:{value:1,unit:'each'}}));assert.equal((await attention('buyer')).status,'receipt');
 ok(await buyer('acknowledgeMarketFulfillment',{idempotencyKey:'attention-ack',fulfillmentId:recordId(report,'fulfillmentId'),expectedRecordVersion:1}));assert.equal((await attention('buyer')).status,'completed');
 await reconcileMarket(f);
});
