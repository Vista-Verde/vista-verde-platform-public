import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { ok } from './helpers.ts';
import { mcp } from './web-helpers.ts';
import { setup,settled,route,switchTo,submitted,confirm,report,acknowledge,snapshot } from './market-browser-helpers.ts';
import { execute,recordId,getOrder,getProposal,getCommitment,getSourcing,financialSnapshot,noFinancialEffects,reconcileMarket } from './market-helpers.ts';

async function postWork(page:Page,url:string,need:string,value=12,budget='1200.00'){
  await route(page,url,'post-work/PANEL-DEMO');await page.getByLabel('Concrete need',{exact:true}).fill(need);
  await page.getByLabel('Quantity (each)',{exact:true}).fill(String(value));await page.getByLabel('Total budget (USD)',{exact:true}).fill(budget);
  await page.getByLabel('Delivery location',{exact:true}).fill('Browser synthetic receiving site');
  await page.getByLabel('Work order terms',{exact:true}).fill('Synthetic concrete need; explicit all-in output price and receiver acknowledgement.');
  return recordId(ok(await submitted(page,'postWorkOrder',()=>page.getByRole('button',{name:'Post work order',exact:true}).click())),'workOrderId');
}
async function respond(page:Page,value:number,price:string){
  await page.getByLabel('Response quantity (each)',{exact:true}).fill(String(value));await page.getByLabel('Response unit price (USD)',{exact:true}).fill(price);
  await page.getByLabel('Response origin',{exact:true}).fill('Browser producer workshop');
  await page.getByLabel('Response terms',{exact:true}).fill('Synthetic private capacity response; output price already includes producer inputs.');
  return ok(await submitted(page,'respondToWorkOrder',()=>page.getByRole('button',{name:'Propose producer response',exact:true}).click()));
}

test('work Chromium: primary board publishes a concrete need and total budget, links a nonbinding supply candidate and fulfills direct producer responses of 8+4', {timeout:120000},async t=>{
  const f=await setup(t),{page}=await f.page('buyer-agent'),buyer=execute(f,'buyer'),finances=await financialSnapshot(f);
  await route(page,f.api.url,'work-orders');await page.getByRole('heading',{name:'Work orders',exact:true}).waitFor();
  const need='Browser concrete need: 12 illustrative panels';const workId=await postWork(page,f.api.url,need);
  await route(page,f.api.url,'work-orders');await page.getByRole('searchbox',{name:'Search work orders',exact:true}).fill(need);
  const search=page.waitForResponse(response=>response.url().endsWith('/queries/listWorkOrders')&&response.request().postDataJSON().search===need);
  await page.getByRole('button',{name:'Search',exact:true}).click();await(await search).finished();await settled(page);
  assert.equal(await page.locator(`[data-work-order-id="${workId}"]`).count(),1);await snapshot(page,'work-orders-desktop.png');
  await switchTo(page,'buyer');await route(page,f.api.url,`work/${workId}`);
  await page.getByLabel('Supply listing',{exact:true}).selectOption('materialtimber-a');await page.getByLabel('Source quantity (each)',{exact:true}).fill('8');
  await submitted(page,'linkMaterialSource',()=>page.getByRole('button',{name:'Link supply candidate',exact:true}).click());
  assert.equal((await getOrder(buyer,'materialtimber-a')).remainingQuantity.value,12);assert.equal((await getOrder(buyer,workId)).budgetCommitted?.minorUnits,0);
  await switchTo(page,'producer-a');await route(page,f.api.url,`work/${workId}`);
  const responseA=await respond(page,8,'90.00'),proposalA=recordId(responseA,'proposalId');
  assert.equal((await getProposal(buyer,proposalA)).buyerApproved,false);assert.equal((await getOrder(buyer,workId)).remainingQuantity.value,12);
  assert.equal((await f.pool.query('SELECT count(*) FROM market_orders WHERE id=$1 AND kind=$2',[responseA.recordIds.sellOrderId,'material_listing'])).rows[0].count,'0');
  await confirm(page);await switchTo(page,'buyer');await route(page,f.api.url,`proposal/${proposalA}`);
  const commitmentA=recordId(await confirm(page),'commitmentId');
  await switchTo(page,'producer-a');await route(page,f.api.url,`commitment/${commitmentA}`);await report(page,5);
  await switchTo(page,'buyer');await route(page,f.api.url,`commitment/${commitmentA}`);await acknowledge(page,5);
  assert.equal((await getCommitment(buyer,commitmentA)).remainingQuantity.value,3);
  await switchTo(page,'producer-a');await route(page,f.api.url,`commitment/${commitmentA}`);await report(page,3);
  await switchTo(page,'buyer');await route(page,f.api.url,`commitment/${commitmentA}`);await acknowledge(page,3);
  await switchTo(page,'producer-b');await route(page,f.api.url,`work/${workId}`);
  const responseB=await respond(page,4,'95.00'),proposalB=recordId(responseB,'proposalId');await confirm(page);
  await switchTo(page,'buyer');await route(page,f.api.url,`proposal/${proposalB}`);const commitmentB=recordId(await confirm(page),'commitmentId');
  await switchTo(page,'producer-b');await route(page,f.api.url,`commitment/${commitmentB}`);await report(page,4);
  await switchTo(page,'buyer');await route(page,f.api.url,`commitment/${commitmentB}`);await acknowledge(page,4);
  await route(page,f.api.url,`work/${workId}`);await page.reload();await settled(page);await snapshot(page,'work-order-completed-desktop.png');
  const work=await getOrder(buyer,workId);assert.equal(work.acknowledgedQuantity.value,12);assert.equal(work.remainingQuantity.value,0);
  assert.equal(work.budgetCommitted?.minorUnits,110000);assert.equal(work.remainingBudget?.minorUnits,10000);
  const agent=await mcp(f,'buyer');assert.equal((await getOrder(agent.call,workId)).acknowledgedQuantity.value,12);
  await noFinancialEffects(f,finances);await reconcileMarket(f);
});

test('work Chromium: independent raw materials and component outputs publish without work orders and remain separate from private capacity',async t=>{
  const f=await setup(t),{page}=await f.page('producer-a');
  await route(page,f.api.url,'post-material/TIMBER-DEMO');await page.getByLabel('Quantity (each)',{exact:true}).fill('10');
  await page.getByLabel('Unit price (USD)',{exact:true}).fill('1.00');await page.getByLabel('Supply location',{exact:true}).fill('Browser independent timber yard');
  const materialId=recordId(ok(await submitted(page,'postMaterialListing',()=>page.getByRole('button',{name:'Post supply listing',exact:true}).click())),'materialListingId');
  await route(page,f.api.url,'post-material/PANEL-DEMO');await page.getByLabel('Quantity (each)',{exact:true}).fill('2');
  await page.getByLabel('Unit price (USD)',{exact:true}).fill('85.00');await page.getByLabel('Supply mode',{exact:true}).selectOption('made_to_order');
  await page.getByLabel('Supply location',{exact:true}).fill('Browser independent component workshop');
  const componentId=recordId(ok(await submitted(page,'postMaterialListing',()=>page.getByRole('button',{name:'Post supply listing',exact:true}).click())),'materialListingId');
  await route(page,f.api.url,'materials');await page.getByRole('heading',{name:'Buy',exact:true}).waitFor();
  assert.equal(await page.locator(`[data-material-listing-id="${materialId}"]`).count(),1);assert.equal(await page.locator(`[data-material-listing-id="${componentId}"]`).count(),1);
  await snapshot(page,'supply-listings-desktop.png');await page.reload();await settled(page);
  assert.equal((await getOrder(execute(f,'buyer'),materialId)).kind,'material_listing');assert.equal((await getOrder(execute(f,'buyer'),componentId)).supplyMode,'made_to_order');
  await reconcileMarket(f);
});

test('work Chromium: explicit material purchase and receiver acknowledgement create inventory; use eight and list the two-unit remainder with provenance', {timeout:120000},async t=>{
  const f=await setup(t),{page}=await f.page('producer-b'),b=execute(f,'producer-b'),finances=await financialSnapshot(f);
  await route(page,f.api.url,'order/materialtimber-a');await page.getByLabel('Your input work order',{exact:true}).selectOption('material-input-work-b');
  await page.getByLabel('Proposed quantity (each)',{exact:true}).fill('10');await page.getByLabel('Proposed unit price (USD)',{exact:true}).fill('1.00');
  const proposalId=recordId(ok(await submitted(page,'proposeMarketAllocation',()=>page.getByRole('button',{name:'Propose allocation',exact:true}).click())),'proposalId');
  await confirm(page);await switchTo(page,'producer-a');await route(page,f.api.url,`proposal/${proposalId}`);const commitmentId=recordId(await confirm(page),'commitmentId');
  await route(page,f.api.url,`commitment/${commitmentId}`);await report(page,10);
  assert.equal((await getSourcing(b)).lots.length,0);await switchTo(page,'producer-b');await route(page,f.api.url,`commitment/${commitmentId}`);
  const acknowledged=await acknowledge(page,10),lotId=recordId(acknowledged,'lotId');
  await route(page,f.api.url,'sourcing');let lot=page.locator(`[data-lot-id="${lotId}"]`);
  await lot.getByText('Record use of this lot',{exact:true}).click();await lot.getByLabel('Used quantity (each)',{exact:true}).fill('8');
  await lot.getByLabel('Use note',{exact:true}).fill('Manual use of eight illustrative timber pieces; no automatic output or recipe.');
  await submitted(page,'recordMaterialUse',()=>lot.getByRole('button',{name:'Record material use',exact:true}).click());
  await route(page,f.api.url,'sourcing');lot=page.locator(`[data-lot-id="${lotId}"]`);assert.match(await lot.innerText(),/8 used \+ 0 offered \+ 0 allocated \+ 2 available = 10 each/);
  await snapshot(page,'inventory-leftover-desktop.png');await lot.getByRole('link',{name:'Offer available remainder with provenance',exact:false}).click();await settled(page);
  await page.getByLabel('Quantity (each)',{exact:true}).fill('2');await page.getByLabel('Unit price (USD)',{exact:true}).fill('1.00');
  await page.getByLabel('Supply location',{exact:true}).fill('Browser reusable leftover shelf');
  const leftoverId=recordId(ok(await submitted(page,'postMaterialListing',()=>page.getByRole('button',{name:'Post supply listing',exact:true}).click())),'materialListingId');
  assert.equal((await getOrder(b,leftoverId)).sourceLotId,lotId);await route(page,f.api.url,'sourcing');await page.reload();await settled(page);
  lot=page.locator(`[data-lot-id="${lotId}"]`);assert.match(await lot.innerText(),/8 used \+ 2 offered \+ 0 allocated \+ 0 available = 10 each/);
  assert.equal(await lot.getByRole('link',{name:'Offer available remainder with provenance',exact:false}).count(),0);
  await page.getByLabel('Upstream work order',{exact:true}).selectOption('panel-buy');await page.getByLabel('Downstream work order',{exact:true}).selectOption('material-input-work-b');
  const cycle=await submitted(page,'linkWorkStages',()=>page.getByRole('button',{name:'Link work stages',exact:true}).click());assert.equal(cycle.ok,false);if(!cycle.ok)assert.equal(cycle.code,'MATCH_INVALID');
  assert.equal((await getOrder(execute(f,'buyer'),'panel-buy')).budgetCommitted?.minorUnits,0);
  await noFinancialEffects(f,finances);await reconcileMarket(f);
});

test('work Chromium: double submit and a committed lost reply recover the original concrete need, total budget and key after refresh',async t=>{
  const f=await setup(t),{page}=await f.page('buyer-agent');await route(page,f.api.url,'post-work/PANEL-DEMO');
  await page.getByLabel('Concrete need',{exact:true}).fill('Frozen browser concrete work request');await page.getByLabel('Quantity (each)',{exact:true}).fill('12');
  await page.getByLabel('Total budget (USD)',{exact:true}).fill('1200.00');await page.getByLabel('Delivery location',{exact:true}).fill('Frozen original delivery site');
  const requests:unknown[]=[];page.on('request',request=>{if(request.url().endsWith('/commands/postWorkOrder'))requests.push(request.postDataJSON());});
  await page.route('**/commands/postWorkOrder',async request=>{await request.fetch();await request.abort('failed');});
  await page.getByRole('button',{name:'Post work order',exact:true}).evaluate(button=>{const form=button.closest('form')!;form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
  await page.getByRole('button',{name:'Retry saved request',exact:true}).waitFor();await settled(page);assert.equal(requests.length,1);
  await page.unroute('**/commands/postWorkOrder');await page.reload();await page.getByRole('button',{name:'Retry saved request',exact:true}).waitFor();
  const recovered=ok(await submitted(page,'postWorkOrder',()=>page.getByRole('button',{name:'Retry saved request',exact:true}).click()));
  assert.equal(requests.length,2);assert.deepEqual(requests[1],requests[0]);const work=await getOrder(execute(f,'buyer'),recordId(recovered,'workOrderId'));
  assert.equal(work.need,'Frozen browser concrete work request');assert.equal(work.budget?.minorUnits,120000);
  assert.equal((await f.pool.query("SELECT count(*) FROM market_orders WHERE need='Frozen browser concrete work request'")).rows[0].count,'1');await reconcileMarket(f);
});

test('work Chromium mobile: primary need, supply and manual-stage views retain branding, readable budgets, keyboard navigation and axe accessibility',async t=>{
  const f=await setup(t),{page}=await f.page('producer-b',{width:390,height:844});
  await route(page,f.api.url,'work-orders');await page.getByRole('heading',{name:'Work orders',exact:true}).waitFor();await snapshot(page,'work-orders-mobile.png');
  await route(page,f.api.url,'work/panel-buy');await snapshot(page,'work-order-detail-mobile.png');
  const response=await respond(page,4,'95.00');await page.getByLabel('I approve these frozen terms for my business.',{exact:true}).check();
  await page.getByLabel('I approve these frozen terms for my business.',{exact:true}).focus();await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button',{name:'Confirm frozen terms',exact:true}).evaluate(button=>button===document.activeElement),true);
  assert.equal((await getProposal(execute(f,'buyer'),recordId(response,'proposalId'))).sellerApproved,false);
  await route(page,f.api.url,'materials');await snapshot(page,'supply-listings-mobile.png');await route(page,f.api.url,'sourcing');await snapshot(page,'inventory-stages-mobile.png');
  const hash=new URL(page.url()).hash;await page.getByRole('link',{name:'Skip to market workspace',exact:true}).focus();await page.keyboard.press('Enter');
  assert.equal(new URL(page.url()).hash,hash);assert.equal(await page.locator('#market-app').evaluate(main=>main===document.activeElement),true);await reconcileMarket(f);
});
