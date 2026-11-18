import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { localPool,PostgresRepository } from '../../packages/db/src/postgres.ts';
import { Application } from '../../packages/domain/src/index.ts';
import { marketItemDetailSchema,marketAuditSchema } from '../../packages/contracts/src/market.ts';
import { fixture,ok,failure } from './helpers.ts';
import { execute,orderInput,proposalInput,confirmationInput,reportInput,acknowledgementInput,
  recordId,getOrder,getProposal,getCommitment,getProject,getWorkspace,propose,approve,commit,
  reportAndAcknowledge,orderCounters,commitmentCounters,marketSnapshot,
  financialSnapshot,noMutation,noFinancialEffects,reconcileMarket } from './market-helpers.ts';

test('market: one business posts both sides; stock and made-to-order listings expose comparison terms without financial effects',async t => {
  const f=await fixture(t),buyer=execute(f,'buyer'),seller=execute(f,'producer-a');
  const finances=await financialSnapshot(f);
  const buy=orderInput('both-buy','buy',3);
  const sell=orderInput('both-sell','sell',2,{supplyMode:'made_to_order',unitPrice:{minorUnits:11000,currency:'USD'}});
  const bought=recordId(ok(await seller('createMarketOrder',buy)),'orderId');
  const offered=recordId(ok(await seller('createMarketOrder',sell)),'orderId');
  const own=await getWorkspace(seller);
  assert.ok(own.orders.some(order=>order.orderId===bought && order.side==='buy'));
  assert.ok(own.orders.some(order=>order.orderId===offered && order.side==='sell'));
  const item=marketItemDetailSchema.parse(ok(await buyer('getMarketItem',{itemId:'PANEL-DEMO',limit:100})).data);
  const stock=item.sellOrders.find(order=>order.orderId==='panel-sell-a')!;
  const mto=item.sellOrders.find(order=>order.orderId===offered)!;
  assert.equal(stock.supplyMode,'stock'); assert.equal(mto.supplyMode,'made_to_order');
  assert.equal(mto.quantity.value,2); assert.equal(mto.remainingQuantity.value,2); assert.equal(mto.unitPrice.minorUnits,11000);
  assert.equal(mto.location,sell.location); assert.equal(mto.availableAt,sell.availableAt); assert.equal(mto.deliveryBy,sell.deliveryBy);
  assert.equal(item.buyOrders.find(order=>order.orderId===bought)?.organizationId,mto.organizationId);
  const serialized=JSON.stringify(item);
  for (const privateField of ['token_hash','grantId','account_id','balanceMinorUnits','reservedMinorUnits']) assert.equal(serialized.includes(privateField),false);
  await noFinancialEffects(f,finances); await reconcileMarket(f);
});

test('market: a proposal freezes both orders and price but consumes nothing and gives its author no implicit consent',async t => {
  const f=await fixture(t),buyer=execute(f,'buyer'),seller=execute(f,'producer-a');
  const finances=await financialSnapshot(f);
  const input=proposalInput('exploratory'); const proposalId=await propose(f,input);
  const proposed=await getProposal(buyer,proposalId);
  assert.equal(proposed.state,'proposed'); assert.equal(proposed.buyerApproved,false); assert.equal(proposed.sellerApproved,false);
  assert.equal(proposed.buyOrderSnapshot.unitPrice.minorUnits,10000);
  assert.equal(proposed.sellOrderSnapshot.unitPrice.minorUnits,9000);
  assert.equal(proposed.unitPrice.minorUnits,9000,'A proposed price is explicit even when the demand price differs');
  assert.equal(proposed.quantity.value,8);
  assert.equal((await getOrder(buyer,'panel-buy')).remainingQuantity.value,12);
  assert.equal((await getOrder(seller,'panel-sell-a')).remainingQuantity.value,8);
  assert.equal((await f.pool.query('SELECT count(*) FROM market_approvals')).rows[0].count,'0');
  assert.equal((await f.pool.query('SELECT count(*) FROM market_commitments')).rows[0].count,'0');
  await noMutation(f,async()=>failure(await execute(f,'buyer-agent')('confirmMarketProposal',confirmationInput('agent-cannot-confirm',proposalId,1)),'FORBIDDEN'));
  await approve(f,proposalId,'buyer');
  const partial=await getProposal(seller,proposalId);
  assert.equal(partial.state,'partially_approved'); assert.equal(partial.buyerApproved,true); assert.equal(partial.sellerApproved,false);
  assert.equal((await getOrder(buyer,'panel-buy')).allocatedQuantity.value,0);
  await noMutation(f,async()=>failure(await seller('confirmMarketProposal',confirmationInput('stale-consent',proposalId,1)),'REVISION_CONFLICT'));
  const confirmed=await approve(f,proposalId,'producer-a');
  assert.ok(confirmed.recordIds.commitmentId);
  const obligation=await getCommitment(buyer,recordId(confirmed,'commitmentId'));
  assert.equal(obligation.quantity.value,8); assert.equal(obligation.unitPrice.minorUnits,9000);
  assert.deepEqual(obligation.buyOrderSnapshot,proposed.buyOrderSnapshot);
  assert.deepEqual(obligation.sellOrderSnapshot,proposed.sellOrderSnapshot);
  await noFinancialEffects(f,finances); await reconcileMarket(f);
});

test('market: wrong item, specification, unit, self-match and unrelated proposers cannot create an allocation',async t => {
  const f=await fixture(t),buyer=execute(f,'buyer');
  const ownSell=recordId(ok(await buyer('createMarketOrder',orderInput('own-sell','sell',1))),'orderId');
  await f.pool.query(`INSERT INTO market_items(id,specification_revision,name,description,specification_label,unit,specification)
    SELECT id,2,name,description,'demo-r2',unit,specification FROM market_items WHERE id='PANEL-DEMO' AND specification_revision=1`);
  const wrongSpec=recordId(ok(await execute(f,'producer-a')('createMarketOrder',orderInput('wrong-spec','sell',1,{specificationRevision:2}))),'orderId');
  const cases=[
    [proposalInput('wrong-item','panel-buy','door-sell-a',1),'MATCH_INVALID'],
    [proposalInput('wrong-spec','panel-buy',wrongSpec,1),'MATCH_INVALID'],
    [proposalInput('own-match','panel-buy',ownSell,1),'MATCH_INVALID'],
    [{...proposalInput('wrong-unit'),quantity:{value:8,unit:'kg'}},'VALIDATION_FAILED'],
    [{...proposalInput('forged-owner'),organizationId:'buyer-org'},'VALIDATION_FAILED']
  ] as const;
  for (const [input,code] of cases) await noMutation(f,async()=>failure(await buyer('proposeMarketAllocation',input),code));
  await noMutation(f,async()=>failure(await execute(f,'other-buyer')('proposeMarketAllocation',proposalInput('unrelated')),'FORBIDDEN'));
  await noMutation(f,async()=>failure(await buyer('proposeMarketAllocation',proposalInput('stale-order',undefined,undefined,8,{expectedBuyVersion:2})),'REVISION_CONFLICT'));
  assert.equal((await f.pool.query('SELECT count(*) FROM market_commitments')).rows[0].count,'0'); await reconcileMarket(f);
});

test('market: catalog pagination has one latest specification per item and scoped public books reveal only permitted orders',async t=>{
  const f=await fixture(t),buyer=execute(f,'buyer');
  await f.pool.query(`INSERT INTO market_items(id,specification_revision,name,description,specification_label,unit,specification)
    SELECT id,2,name,description,'demo-r2',unit,specification FROM market_items WHERE id='PANEL-DEMO' AND specification_revision=1`);
  const ids:string[]=[];let cursor:string|undefined;
  do {
    const data=ok(await buyer('listMarketItems',{limit:1,...(cursor ? {cursor} : {})})).data as {items:{itemId:string;specificationRevision:number}[];nextCursor:string|null};
    assert.equal(data.items.length,1);ids.push(data.items[0]!.itemId);
    if(data.items[0]!.itemId==='PANEL-DEMO')assert.equal(data.items[0]!.specificationRevision,2);
    cursor=data.nextCursor ?? undefined;
  } while(cursor);
  assert.equal(ids.length,Number((await f.pool.query('SELECT count(DISTINCT id) FROM market_items')).rows[0].count));
  assert.equal(new Set(ids).size,ids.length);
  const first=marketItemDetailSchema.parse(ok(await buyer('getMarketItem',{itemId:'PANEL-DEMO',limit:2})).data);
  assert.ok(first.nextCursor);
  const second=marketItemDetailSchema.parse(ok(await buyer('getMarketItem',{itemId:'PANEL-DEMO',limit:2,cursor:first.nextCursor})).data);
  const orders=[...first.buyOrders,...first.sellOrders,...second.buyOrders,...second.sellOrders];
  assert.equal(orders.length,4);assert.equal(new Set(orders.map(order=>order.orderId)).size,4);assert.equal(second.nextCursor,null);
  await f.pool.query("UPDATE grants SET market_scopes=ARRAY['panel-buy'] WHERE id=$1",[f.context('buyer').grantId]);
  const scoped=marketItemDetailSchema.parse(ok(await buyer('getMarketItem',{itemId:'PANEL-DEMO'})).data);
  assert.deepEqual(scoped.buyOrders.map(order=>order.orderId),['panel-buy']);assert.deepEqual(scoped.sellOrders,[]);
  assert.deepEqual((ok(await buyer('listMarketItems',{})).data.items as {itemId:string}[]).map(item=>item.itemId),['PANEL-DEMO']);
  await noMutation(f,async()=>failure(await buyer('getMarketOrder',{orderId:'panel-sell-a'}),'FORBIDDEN'));
  await noMutation(f,async()=>failure(await buyer('getHouseProject',{projectId:'house-demo'}),'FORBIDDEN'));
  await reconcileMarket(f);
});

test('market: supply available after the buyer deadline cannot be proposed as a compatible allocation',async t=>{
  const f=await fixture(t),seller=execute(f,'producer-a');
  const late=orderInput('late-supply','sell',1,{availableAt:new Date(Date.now()+8*86400000).toISOString(),deliveryBy:new Date(Date.now()+9*86400000).toISOString()});
  const orderId=recordId(ok(await seller('createMarketOrder',late)),'orderId');
  await noMutation(f,async()=>failure(await execute(f,'buyer')('proposeMarketAllocation',proposalInput('late-allocation','panel-buy',orderId,1)),'MATCH_INVALID'));
  assert.equal((await getOrder(seller,orderId)).allocatedQuantity.value,0);await reconcileMarket(f);
});

test('market: two suppliers allocate 8+4 and acknowledge 5/3/4; completed components never reopen or complete the whole house',async t => {
  const f=await fixture(t),buyer=execute(f,'buyer'); const finances=await financialSnapshot(f);
  const pA=await propose(f,proposalInput('panels-eight'));
  const pB=await propose(f,proposalInput('panels-four','panel-buy','panel-sell-b',4,{unitPrice:{minorUnits:9500,currency:'USD'}}));
  assert.equal((await getOrder(buyer,'panel-buy')).remainingQuantity.value,12);
  await approve(f,pA,'buyer'); const cA=recordId(await approve(f,pA,'producer-a'),'commitmentId');
  assert.equal((await getOrder(buyer,'panel-buy')).remainingQuantity.value,4);
  // Allocating A advances the record version, but does not amend B's frozen terms.
  await approve(f,pB,'buyer'); const cB=recordId(await approve(f,pB,'producer-b'),'commitmentId');
  assert.equal((await getOrder(buyer,'panel-buy')).remainingQuantity.value,0);
  assert.equal((await getOrder(buyer,'panel-buy')).acknowledgedQuantity.value,0);
  const first=await reportAndAcknowledge(f,cA,5,'producer-a','five');
  assert.equal((await getCommitment(buyer,cA)).remainingQuantity.value,3);
  assert.equal((await getOrder(buyer,'panel-buy')).acknowledgedQuantity.value,5);
  assert.equal((await getOrder(buyer,'panel-buy')).reportedQuantity.value,5,'A report and its acknowledgement are never summed');
  const beforeReplay=await marketSnapshot(f);
  assert.deepEqual(await execute(f,'producer-a')('reportMarketFulfillment',first.report),first.reported);
  assert.deepEqual(await buyer('acknowledgeMarketFulfillment',first.acknowledgement),first.acknowledged);
  assert.deepEqual(await marketSnapshot(f),beforeReplay);
  await reportAndAcknowledge(f,cA,3,'producer-a','three'); await reportAndAcknowledge(f,cB,4,'producer-b','four');
  for (const id of [cA,cB]) assert.equal((await getCommitment(buyer,id)).state,'completed');
  const panel=await getOrder(buyer,'panel-buy');
  assert.equal(panel.allocatedQuantity.value,12); assert.equal(panel.acknowledgedQuantity.value,12); assert.equal(panel.remainingQuantity.value,0);
  for (const id of ['panel-sell-a','panel-sell-b']) assert.equal((await getOrder(buyer,id)).remainingQuantity.value,0);
  const project=await getProject(buyer);
  assert.equal(project.wholeHouseOrder.quantity.value,1); assert.equal(project.wholeHouseOrder.allocatedQuantity.value,0);
  assert.equal(project.wholeHouseOrder.acknowledgedQuantity.value,0);
  assert.equal(project.componentOrders.find(order=>order.orderId==='door-buy')?.acknowledgedQuantity.value,0);
  assert.equal(project.componentOrders.find(order=>order.orderId==='roof-buy')?.acknowledgedQuantity.value,0);
  assert.equal(project.componentOrders.find(order=>order.orderId==='panel-buy')?.acknowledgedQuantity.value,12);
  assert.equal((await f.pool.query("SELECT count(*) FROM market_commitments WHERE buy_order_id='house-buy'")).rows[0].count,'0');
  await noMutation(f,async()=>failure(await execute(f,'producer-a')('reportMarketFulfillment',reportInput('over-complete',cA,(await commitmentCounters(f,cA)).version,1)),'FULFILLMENT_CONFLICT'));
  await noMutation(f,async()=>failure(await buyer('proposeMarketAllocation',proposalInput('completed-does-not-reopen','panel-buy','panel-sell-a',1,{expectedBuyVersion:3,expectedSellVersion:2})),'ORDER_UNAVAILABLE'));
  await noFinancialEffects(f,finances); await reconcileMarket(f);
});

test('market: independent PostgreSQL connections race the last demand and last supply separately, with exactly one final confirmation', {timeout:60000},async t => {
  const f=await fixture(t),finances=await financialSnapshot(f);
  const poolA=localPool(f.connectionString),poolB=localPool(f.connectionString);
  f.cleanupWith(()=>poolA.end()); f.cleanupWith(()=>poolB.end());
  const pids=await Promise.all([poolA.query('SELECT pg_backend_pid() AS pid'),poolB.query('SELECT pg_backend_pid() AS pid')]);
  assert.notEqual(pids[0]!.rows[0].pid,pids[1]!.rows[0].pid);
  const a=new Application(new PostgresRepository(poolA)),b=new Application(new PostgresRepository(poolB));
  for (const resource of ['demand','supply'] as const) for (let round=0;round<6;round++) {
    const tag=`${resource}-${round}`;
    const buy1=recordId(ok(await execute(f,'buyer')('createMarketOrder',orderInput(`${tag}-buy1`,'buy'))),'orderId');
    const buy2=resource==='demand' ? buy1 : recordId(ok(await execute(f,'other-buyer')('createMarketOrder',orderInput(`${tag}-buy2`,'buy'))),'orderId');
    const sell1=recordId(ok(await execute(f,'producer-a')('createMarketOrder',orderInput(`${tag}-sell1`,'sell'))),'orderId');
    const sell2=resource==='supply' ? sell1 : recordId(ok(await execute(f,'producer-b')('createMarketOrder',orderInput(`${tag}-sell2`,'sell'))),'orderId');
    const p1=await propose(f,proposalInput(`${tag}-p1`,buy1,sell1,1),'buyer');
    const secondBuyer=resource==='demand' ? 'buyer' : 'other-buyer';
    const secondSeller=resource==='supply' ? 'producer-a' : 'producer-b';
    const p2=await propose(f,proposalInput(`${tag}-p2`,buy2,sell2,1),secondBuyer);
    await approve(f,p1,'buyer'); await approve(f,p2,secondBuyer);
    let start!:()=>void; const gate=new Promise<void>(resolve=>{start=resolve;});
    const input1=confirmationInput(`${tag}-final1`,p1,2),input2=confirmationInput(`${tag}-final2`,p2,2);
    const pending=[(async()=>{await gate;return a.execute('confirmMarketProposal',input1,f.context('producer-a'));})(),
      (async()=>{await gate;return b.execute('confirmMarketProposal',input2,f.context(secondSeller));})()];
    start(); const receipts=await Promise.all(pending);
    assert.equal(receipts.filter(receipt=>receipt.ok).length,1,`${resource} has one remaining each`);
    failure(receipts.find(receipt=>!receipt.ok)!,'ORDER_UNAVAILABLE');
    const constrained=await orderCounters(f,resource==='demand' ? buy1 : sell1);
    assert.equal(constrained.allocated,1); assert.equal(constrained.total,1);
    assert.equal((await f.pool.query('SELECT count(*) FROM market_commitments WHERE proposal_id=ANY($1::text[])',[[p1,p2]])).rows[0].count,'1');
    const winner=receipts[0]!.ok ? 0 : 1; const frozen=receipts[winner]!;
    await noMutation(f,async()=>assert.deepEqual(await (winner===0 ? a : b).execute('confirmMarketProposal',winner===0 ? input1 : input2,f.context(winner===0 ? 'producer-a' : secondSeller)),frozen));
    await reconcileMarket(f);
  }
  await noFinancialEffects(f,finances);
});

test('market: durable scoped keys replay frozen posting/proposal/consent results and changed payloads conflict',async t => {
  const f=await fixture(t),buyer=execute(f,'buyer');
  const posted=orderInput('stable-post','buy',2),postReceipt=ok(await buyer('createMarketOrder',posted));
  await noMutation(f,async()=>assert.deepEqual(await buyer('createMarketOrder',posted),postReceipt));
  await noMutation(f,async()=>failure(await buyer('createMarketOrder',{...posted,quantity:{value:3,unit:'each'}}),'IDEMPOTENCY_CONFLICT'));
  const input=proposalInput('stable-proposal'),proposalReceipt=ok(await buyer('proposeMarketAllocation',input));
  const proposalId=recordId(proposalReceipt,'proposalId');
  await noMutation(f,async()=>assert.deepEqual(await buyer('proposeMarketAllocation',input),proposalReceipt));
  await noMutation(f,async()=>failure(await buyer('proposeMarketAllocation',{...input,unitPrice:{minorUnits:9500,currency:'USD'}}),'IDEMPOTENCY_CONFLICT'));
  const confirmation=confirmationInput('stable-consent',proposalId,1),approved=ok(await buyer('confirmMarketProposal',confirmation));
  const independent=localPool(f.connectionString);f.cleanupWith(()=>independent.end());
  const secondProcess=new Application(new PostgresRepository(independent)),final=confirmationInput('same-key-final',proposalId,2);
  const finals=await Promise.all([execute(f,'producer-a')('confirmMarketProposal',final),secondProcess.execute('confirmMarketProposal',final,f.context('producer-a'))]);
  const committed=ok(finals[0]!);assert.deepEqual(finals[1],committed,'Concurrent retries on separate PostgreSQL pools return the identical frozen result');
  await noMutation(f,async()=>assert.deepEqual(await buyer('confirmMarketProposal',confirmation),approved));
  await noMutation(f,async()=>failure(await buyer('confirmMarketProposal',{...confirmation,expectedRecordVersion:2}),'IDEMPOTENCY_CONFLICT'));
  await noMutation(f,async()=>failure(await buyer('confirmMarketProposal',confirmationInput('new-consent-key',proposalId,3)),'ORDER_UNAVAILABLE'));
  assert.equal((await f.pool.query('SELECT count(*) FROM market_commitments WHERE id=$1',[committed.recordIds.commitmentId])).rows[0].count,'1');
  // Keys are scoped to verified actors and operations, rather than a global namespace.
  const other=ok(await execute(f,'producer-a')('createMarketOrder',orderInput('stable-post','sell',1)));
  assert.notEqual(other.recordIds.orderId,postReceipt.recordIds.orderId); await reconcileMarket(f);
});

test('market: process loss after final commit and restart recover the same commitment after proposal expiry',async t => {
  const f=await fixture(t);
  const proposalId=await propose(f,proposalInput('crash-proposal',undefined,undefined,8,{expiresAt:new Date(Date.now()+1800).toISOString()}));
  await approve(f,proposalId,'buyer');
  const input=confirmationInput('lost-final-reply',proposalId,2);
  const child=fork(new URL('./crash-client.ts',import.meta.url),[],{env:{...process.env,VV_DATABASE_URL:f.connectionString},stdio:['ignore','ignore','pipe','ipc']});
  const exit=once(child,'exit'); child.send({context:f.context('producer-a'),operation:'confirmMarketProposal',input});
  assert.equal((await exit)[0],9,'The separate process commits and exits without returning its result');
  await delay(1850);
  const pool=localPool(f.connectionString); f.cleanupWith(()=>pool.end()); const restarted=new Application(new PostgresRepository(pool));
  const recovered=ok(await restarted.execute('confirmMarketProposal',input,f.context('producer-a')));
  const commitmentId=recordId(recovered,'commitmentId');
  assert.equal((await getCommitment(execute(f,'buyer'),commitmentId)).quantity.value,8);
  await noMutation(f,async()=>assert.deepEqual(await restarted.execute('confirmMarketProposal',input,f.context('producer-a')),recovered));
  assert.equal((await f.pool.query('SELECT count(*) FROM market_commitments')).rows[0].count,'1'); await reconcileMarket(f);
});

test('market: expiry and every live counterparty authority check block final allocation without partial consent',async t => {
  for (const condition of ['revoked','expired','scope','operation','membership'] as const) await t.test(condition,async sub => {
    const f=await fixture(sub),buyer=execute(f,'buyer'),seller=execute(f,'producer-a');
    const proposalId=await propose(f,proposalInput(`authority-${condition}`)); await approve(f,proposalId,'buyer');
    const grant=f.context('buyer').grantId;
    if (condition==='revoked') await f.pool.query('UPDATE grants SET revoked=true WHERE id=$1',[grant]);
    if (condition==='expired') await f.pool.query("UPDATE grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[grant]);
    if (condition==='scope') await f.pool.query('UPDATE grants SET market_scopes=ARRAY[]::text[] WHERE id=$1',[grant]);
    if (condition==='operation') await f.pool.query("UPDATE grants SET operations=array_remove(operations,'confirmMarketProposal') WHERE id=$1",[grant]);
    if (condition==='membership') await f.pool.query("UPDATE memberships SET active=false WHERE actor_id='buyer'");
    await noMutation(f,async()=>failure(await seller('confirmMarketProposal',confirmationInput('blocked-final',proposalId,2)),'FORBIDDEN'));
    assert.equal((await getOrder(seller,'panel-sell-a')).allocatedQuantity.value,0);
    assert.equal((await f.pool.query('SELECT count(*) FROM market_commitments')).rows[0].count,'0');
    // The prior approval remains attributable but it cannot authorize a commitment.
    assert.equal((await f.pool.query('SELECT count(*) FROM market_approvals WHERE proposal_id=$1',[proposalId])).rows[0].count,'1');
    if (condition==='revoked') await noMutation(f,async()=>failure(await buyer('confirmMarketProposal',confirmationInput(`approve-buyer-${proposalId}`,proposalId,1)),'FORBIDDEN'));
    await reconcileMarket(f);
  });
  await t.test('proposal expiry',async sub=>{
    const f=await fixture(sub); const proposalId=await propose(f,proposalInput('expires',undefined,undefined,8,{expiresAt:new Date(Date.now()+500).toISOString()}));
    await approve(f,proposalId,'buyer'); await delay(550);
    await noMutation(f,async()=>failure(await execute(f,'producer-a')('confirmMarketProposal',confirmationInput('after-expiry',proposalId,2)),'PROPOSAL_EXPIRED'));
    assert.equal((await getProposal(execute(f,'buyer'),proposalId)).state,'expired'); await reconcileMarket(f);
  });
});

test('market: counterparty approval that expires during the audit/outbox work rolls the entire final confirmation back',async t=>{
  const f=await fixture(t),proposalId=await propose(f,proposalInput('expiry-during-final'));
  await approve(f,proposalId,'buyer');
  await f.pool.query("UPDATE grants SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",[f.context('buyer').grantId]);
  await f.pool.query("CREATE FUNCTION market_expiry_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.3); RETURN NEW; END $$");
  await f.pool.query('CREATE TRIGGER market_pause_outbox BEFORE INSERT ON market_outbox FOR EACH ROW EXECUTE FUNCTION market_expiry_pause()');
  await noMutation(f,async()=>failure(await execute(f,'producer-a')('confirmMarketProposal',confirmationInput('expires-before-commit',proposalId,2)),'FORBIDDEN'));
  assert.equal((await f.pool.query('SELECT count(*) FROM market_commitments')).rows[0].count,'0');
  assert.equal((await orderCounters(f,'panel-buy')).allocated,0);assert.equal((await orderCounters(f,'panel-sell-a')).allocated,0);
  await reconcileMarket(f);
});

test('market: current actor scope, private records and audit access apply before historical replay',async t => {
  const f=await fixture(t),buyer=execute(f,'buyer'),foreign=execute(f,'other-buyer');
  const input=proposalInput('private-proposal'),receipt=ok(await buyer('proposeMarketAllocation',input)),proposalId=recordId(receipt,'proposalId');
  const c=recordId(await approve(f,proposalId,'buyer'),'proposalId'); assert.equal(c,proposalId);
  const commitmentId=recordId(await approve(f,proposalId,'producer-a'),'commitmentId');
  const report=ok(await execute(f,'producer-a')('reportMarketFulfillment',reportInput('private-report',commitmentId,1,5)));
  for (const [operation,args] of [
    ['getMarketProposal',{proposalId}],['getMarketCommitment',{commitmentId}],['getMarketAudit',{recordId:proposalId}],
    ['acknowledgeMarketFulfillment',acknowledgementInput('foreign-ack',recordId(report,'fulfillmentId'))]
  ] as const) await noMutation(f,async()=>failure(await foreign(operation,args),'FORBIDDEN'));
  const workspace=await getWorkspace(foreign);
  assert.equal(workspace.proposals.some(p=>p.proposalId===proposalId),false); assert.equal(workspace.commitments.some(c=>c.commitmentId===commitmentId),false);
  const audit=marketAuditSchema.parse(ok(await buyer('getMarketAudit',{recordId:proposalId,limit:100})).data);
  assert.ok(audit.events.length>=3); assert.ok(audit.events.some(event=>event.actorId==='producer-a' && event.operation==='confirmMarketProposal'));
  for (const event of audit.events) assert.equal(event.synthetic,true);
  await f.pool.query('UPDATE grants SET market_scopes=ARRAY[]::text[] WHERE id=$1',[f.context('buyer').grantId]);
  await noMutation(f,async()=>failure(await buyer('proposeMarketAllocation',input),'FORBIDDEN'));
  await noMutation(f,async()=>failure(await buyer('getMarketProposal',{proposalId}),'FORBIDDEN'));
  await f.pool.query("UPDATE grants SET market_scopes=ARRAY['panel-buy'] WHERE id=$1",[f.context('buyer').grantId]);
  const narrowed=marketAuditSchema.parse(ok(await buyer('getMarketAudit',{recordId:'panel-buy',limit:100})).data);
  const narrowedText=JSON.stringify(narrowed);
  for(const privateId of [proposalId,commitmentId,recordId(report,'fulfillmentId'),'panel-sell-a'])assert.equal(narrowedText.includes(privateId),false,
    'Owning one order does not reveal private agreement history whose other order is outside the current grant');
  assert.ok(narrowed.events.some(event=>event.operation==='createMarketOrder'),'The permitted public posting audit remains visible');
  await reconcileMarket(f);
});

test('market: reports and acknowledgements enforce party, quantity, revision and duplicate bounds',async t => {
  const f=await fixture(t),buyer=execute(f,'buyer'),seller=execute(f,'producer-a');
  const commitmentId=await commit(f,proposalInput('bounded-delivery'));
  await noMutation(f,async()=>failure(await buyer('reportMarketFulfillment',reportInput('wrong-reporter',commitmentId,1,5)),'FORBIDDEN'));
  await noMutation(f,async()=>failure(await seller('reportMarketFulfillment',reportInput('over-report',commitmentId,1,9)),'FULFILLMENT_CONFLICT'));
  const input=reportInput('bounded-five',commitmentId,1,5),reported=ok(await seller('reportMarketFulfillment',input));
  const fulfillmentId=recordId(reported,'fulfillmentId');
  assert.equal((await getCommitment(buyer,commitmentId)).reportedQuantity.value,5);
  assert.equal((await getCommitment(buyer,commitmentId)).acknowledgedQuantity.value,0);
  assert.equal((await getCommitment(buyer,commitmentId)).remainingQuantity.value,8,'Unacknowledged reports do not complete an obligation');
  await noMutation(f,async()=>failure(await seller('acknowledgeMarketFulfillment',acknowledgementInput('seller-ack',fulfillmentId)),'FORBIDDEN'));
  await noMutation(f,async()=>failure(await buyer('acknowledgeMarketFulfillment',acknowledgementInput('stale-ack',fulfillmentId,2)),'REVISION_CONFLICT'));
  const ackInput=acknowledgementInput('accept-five',fulfillmentId),ack=ok(await buyer('acknowledgeMarketFulfillment',ackInput));
  await noMutation(f,async()=>assert.deepEqual(await buyer('acknowledgeMarketFulfillment',ackInput),ack));
  await noMutation(f,async()=>failure(await buyer('acknowledgeMarketFulfillment',acknowledgementInput('duplicate-new-key',fulfillmentId,2)),'FULFILLMENT_CONFLICT'));
  await noMutation(f,async()=>failure(await seller('reportMarketFulfillment',{...input,quantity:{value:4,unit:'each'}}),'IDEMPOTENCY_CONFLICT'));
  await noMutation(f,async()=>failure(await seller('reportMarketFulfillment',reportInput('over-remaining',commitmentId,(await commitmentCounters(f,commitmentId)).version,4)),'FULFILLMENT_CONFLICT'));
  await reportAndAcknowledge(f,commitmentId,3,'producer-a','bounded-three');
  assert.equal((await getCommitment(buyer,commitmentId)).state,'completed'); await reconcileMarket(f);
});

test('market: a late outbox failure rolls back posting, proposing, consent, allocation, report and acknowledgement with safe same-key recovery',async t => {
  const f=await fixture(t),buyer=execute(f,'buyer'),seller=execute(f,'producer-a');
  const inject=async()=>{
    await f.pool.query("CREATE OR REPLACE FUNCTION market_fixture_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic late fault'; END $$");
    await f.pool.query('CREATE TRIGGER market_fail_outbox BEFORE INSERT ON market_outbox FOR EACH ROW EXECUTE FUNCTION market_fixture_fault()');
  };
  const remove=async()=>{await f.pool.query('DROP TRIGGER market_fail_outbox ON market_outbox');};
  const posted=orderInput('rollback-post','sell',1); await inject();
  await noMutation(f,async()=>failure(await seller('createMarketOrder',posted),'INTERNAL_ERROR')); await remove();
  ok(await seller('createMarketOrder',posted));
  const proposed=proposalInput('rollback-proposal'); await inject();
  await noMutation(f,async()=>failure(await buyer('proposeMarketAllocation',proposed),'INTERNAL_ERROR')); await remove();
  const proposalId=recordId(ok(await buyer('proposeMarketAllocation',proposed)),'proposalId');
  const first=confirmationInput('rollback-buyer-consent',proposalId,1); await inject();
  await noMutation(f,async()=>failure(await buyer('confirmMarketProposal',first),'INTERNAL_ERROR')); await remove(); ok(await buyer('confirmMarketProposal',first));
  const final=confirmationInput('rollback-final-consent',proposalId,2); await inject();
  await noMutation(f,async()=>failure(await seller('confirmMarketProposal',final),'INTERNAL_ERROR')); await remove();
  const commitmentId=recordId(ok(await seller('confirmMarketProposal',final)),'commitmentId');
  const reported=reportInput('rollback-report',commitmentId,1,5); await inject();
  await noMutation(f,async()=>failure(await seller('reportMarketFulfillment',reported),'INTERNAL_ERROR')); await remove();
  const fulfillmentId=recordId(ok(await seller('reportMarketFulfillment',reported)),'fulfillmentId');
  const acknowledged=acknowledgementInput('rollback-ack',fulfillmentId); await inject();
  await noMutation(f,async()=>failure(await buyer('acknowledgeMarketFulfillment',acknowledged),'INTERNAL_ERROR')); await remove();
  const receipt=ok(await buyer('acknowledgeMarketFulfillment',acknowledged));
  await noMutation(f,async()=>assert.deepEqual(await buyer('acknowledgeMarketFulfillment',acknowledged),receipt));
  assert.equal((await commitmentCounters(f,commitmentId)).acknowledged,5); await reconcileMarket(f);
});
