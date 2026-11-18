import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fixture,ok,failure} from './helpers.ts';
import {browserSession,mcp,web} from './web-helpers.ts';
import {acknowledgementInput,confirmationInput,financialSnapshot,getCommitment,getOrder,getProposal,materialListingInput,noFinancialEffects,noMutation,reconcileMarket,recordId,reportInput,responseInput,workOrderInput} from './market-helpers.ts';
import {addPrintFixture,PRINT_ITEM,PRINT_MATERIAL} from './print-fixture.ts';
import {advance} from '../../apps/print-demo/model.ts';

test('print demo: real stdio MCP and HTTP share synthetic print/material, dual consent, replay and counted fulfillment; courier remains simulation',async t=>{
  const f=await fixture(t);await addPrintFixture(f);const finances=await financialSnapshot(f);
  const api=await web(f),http=await browserSession(api.url,'buyer');
  const [agent,buyer,printer,supplier]=await Promise.all(['buyer-agent','buyer','producer-a','producer-b'].map(actor=>mcp(f,actor)));
  const read=(operation:Parameters<typeof http.call>[0],input:unknown)=>http.call(operation,input).then(reply=>reply.receipt);
  const material=ok(await supplier!.call('postMaterialListing',materialListingInput('print-feedstock',4,{itemId:PRINT_MATERIAL,unitPrice:{minorUnits:2000,currency:'USD'},location:'MockSpool synthetic stock',terms:'Fictional counted spools. Candidate supply; no engineering yield or physical stock guarantee.'})));
  const materialId=recordId(material,'materialListingId');
  const workInput=workOrderInput('print-local-fixture',1,3000,{itemId:PRINT_ITEM,need:'One synthetic 20 mm test cube, mock FDM / PETG / 1.75 mm / black.',location:'Fictional Zone A receiving site',terms:'Synthetic fixture only. Producer-sourced material included in USD30 print quote; illustrative USD4 contribution is not charged again. Courier is a separate local simulation; no STL or address supplied.'});
  const work=ok(await agent!.call('postWorkOrder',workInput)),workId=recordId(work,'workOrderId');
  await noMutation(f,async()=>assert.deepEqual(await agent!.call('postWorkOrder',workInput),work));
  await noMutation(f,async()=>failure(await agent!.call('postWorkOrder',{...workInput,need:'Changed terms with the same retry key'}),'IDEMPOTENCY_CONFLICT'));
  const linked=ok(await agent!.call('linkMaterialSource',{idempotencyKey:'print-candidate',workOrderId:workId,materialListingId:materialId,quantity:{value:1,unit:'each'},note:'Nonbinding counted spool candidate. No material conversion, BOM, procurement or consumption claim.'}));
  assert.equal((await getOrder(read,materialId)).remainingQuantity.value,4);
  const response=responseInput('print-response',workId,1,3000,{location:'DemoForge fictional workshop',terms:'Mock P1 FDM / PETG / 1.75 mm. USD30 all-in print price includes synthetic USD4 material contribution; no additional full spool charge. This command records proposed goods terms, not printer execution.'});
  const proposal=ok(await printer!.call('respondToWorkOrder',response)),proposalId=recordId(proposal,'proposalId');
  assert.equal((await getOrder(read,workId)).budgetCommitted?.minorUnits,0);
  assert.equal((await getProposal(read,proposalId)).buyerApproved,false);
  assert.equal((await f.pool.query('SELECT count(*) FROM market_commitments WHERE buy_order_id=$1',[workId])).rows[0].count,'0');
  await noMutation(f,async()=>failure(await agent!.call('confirmMarketProposal',confirmationInput('print-agent-denied',proposalId,1)),'FORBIDDEN'));
  await noMutation(f,async()=>failure(await supplier!.call('getMarketProposal',{proposalId}),'FORBIDDEN'));
  // Deterministic test driver supplies explicit synthetic approvals. This is
  // not real user consent, autonomous agent reasoning or a human-only mandate.
  const buyerApproval=confirmationInput('print-requester-approval',proposalId,1);
  const approved=ok(await buyer!.call('confirmMarketProposal',buyerApproval));assert.equal(approved.state,'partially_approved');
  assert.equal((await getOrder(read,workId)).budgetCommitted?.minorUnits,0);
  const producerApproval=confirmationInput('print-producer-approval',proposalId,2);
  const committed=ok(await printer!.call('confirmMarketProposal',producerApproval)),commitmentId=recordId(committed,'commitmentId');
  await noMutation(f,async()=>assert.deepEqual(await printer!.call('confirmMarketProposal',producerApproval),committed));
  assert.equal((await getCommitment(read,commitmentId)).commitmentId,commitmentId);
  assert.equal((await getOrder(read,workId)).budgetCommitted?.minorUnits,3000);
  // Physical production and courier only advance the separate local model.
  let simulation=advance('draft','approve_print',true);simulation=advance(simulation,'approve_delivery',true);
  for(const event of ['produce','dispatch','deliver'] as const)simulation=advance(simulation,event,true);
  assert.equal(simulation,'delivered');assert.equal((await getCommitment(read,commitmentId)).acknowledgedQuantity.value,0);
  await noMutation(f,async()=>failure(await printer!.call('reportMarketFulfillment',reportInput('print-over-report',commitmentId,1,2)),'FULFILLMENT_CONFLICT'));
  const report=reportInput('print-reported',commitmentId,1,1),reported=ok(await printer!.call('reportMarketFulfillment',report)),fulfillmentId=recordId(reported,'fulfillmentId');
  assert.equal((await getCommitment(read,commitmentId)).acknowledgedQuantity.value,0);
  await noMutation(f,async()=>assert.deepEqual(await printer!.call('reportMarketFulfillment',report),reported));
  const ack=acknowledgementInput('print-receiver-ack',fulfillmentId),acknowledged=ok(await buyer!.call('acknowledgeMarketFulfillment',ack));
  await noMutation(f,async()=>assert.deepEqual(await buyer!.call('acknowledgeMarketFulfillment',ack),acknowledged));
  await noMutation(f,async()=>failure(await buyer!.call('acknowledgeMarketFulfillment',{...ack,idempotencyKey:'print-duplicate-ack',expectedRecordVersion:2}),'FULFILLMENT_CONFLICT'));
  const completed=await getCommitment(read,commitmentId);assert.equal(completed.state,'completed');assert.equal(completed.reportedQuantity.value,1);assert.equal(completed.acknowledgedQuantity.value,1);
  assert.equal((await getOrder(read,workId)).budgetCommitted?.minorUnits,3000,'Receipt does not reopen the stated budget');
  await noFinancialEffects(f,finances);await reconcileMarket(f);
  if(process.env.VV_PRINT_TRACE==='1')console.log(JSON.stringify({synthetic:true,driver:'deterministic test software; no model runner',storage:'disposable generated PostgreSQL',commands:'real SDK stdio MCP',readback:'real shared HTTP',recordIds:{materialId,workId,sourceLinkId:linked.recordIds.linkId,proposalId,commitmentId,fulfillmentId},printQuoteMinor:3000,materialContributionIncludedMinor:400,courierSimulationMinor:1000,customerIllustrationMinor:4000,courierTracking:'DEMO-PARCEL-001 (local simulation)',acknowledged:1,financialRecordsUnchanged:true}));
});

test('print demo: insufficient stated print budget rejects final consent atomically; fixture cannot target an operating database',async t=>{
  const f=await fixture(t);await addPrintFixture(f);const finances=await financialSnapshot(f);
  await assert.rejects(()=>addPrintFixture({...f,connectionString:'postgresql://localhost/vista_verde_work_orders'}),/disposable/);
  const mismatch=new URL(f.connectionString);mismatch.pathname='/vv_'+'0'.repeat(32);
  const itemsBefore=await f.pool.query('SELECT id FROM market_items ORDER BY id');
  await assert.rejects(()=>addPrintFixture({...f,connectionString:mismatch.toString()}),/pool does not match/);
  assert.deepEqual((await f.pool.query('SELECT id FROM market_items ORDER BY id')).rows,itemsBefore.rows);
  const buyer=await mcp(f,'buyer'),printer=await mcp(f,'producer-a');
  const workId=recordId(ok(await buyer.call('postWorkOrder',workOrderInput('print-insufficient',1,2999,{itemId:PRINT_ITEM}))),'workOrderId');
  const proposalId=recordId(ok(await printer.call('respondToWorkOrder',responseInput('print-too-expensive',workId,1,3000))),'proposalId');
  ok(await buyer.call('confirmMarketProposal',confirmationInput('print-budget-first',proposalId,1)));
  await noMutation(f,async()=>failure(await printer.call('confirmMarketProposal',confirmationInput('print-budget-final',proposalId,2)),'BUDGET_EXCEEDED'));
  assert.equal((await getOrder(buyer.call,workId)).allocatedQuantity.value,0);assert.equal((await getOrder(buyer.call,workId)).budgetCommitted?.minorUnits,0);
  assert.equal((await getProposal(buyer.call,proposalId)).sellerApproved,false);
  await noFinancialEffects(f,finances);await reconcileMarket(f);
});
