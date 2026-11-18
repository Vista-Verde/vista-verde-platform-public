import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { mkdirSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import type { AxeResults } from 'axe-core';
import type { Envelope,Operation } from '../../packages/contracts/src/index.ts';
import { envelope } from '../../packages/contracts/src/index.ts';
import { fixture,ok } from './helpers.ts';
import { web,mcp } from './web-helpers.ts';
import { execute,proposalInput,recordId,propose,approve,commit,
  getOrder,getProposal,getCommitment,getProject,financialSnapshot,noFinancialEffects,reconcileMarket } from './market-helpers.ts';

const axeSource=readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'),'utf8');
const artifacts=resolve(process.env.VV_WEB_ARTIFACTS ?? 'web-artifacts'); mkdirSync(artifacts,{recursive:true});

async function settled(page: Page) { await page.locator('#market-app[aria-busy="false"]').waitFor(); }
async function setup(t: Parameters<typeof fixture>[0]) {
  const f=await fixture(t),api=await web(f),browser=await chromium.launch(); f.cleanupWith(()=>browser.close());
  const errors: string[]=[];
  async function page(persona: string,viewport={width:1440,height:1080}) {
    const context=await browser.newContext({viewport}),page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message)); await page.goto(api.url);
    const labels: Record<string,string>={'buyer-agent':'Buyer agent · draft demand','buyer':'Buyer human · review & publish',
      'producer-a':'Producer A · reviewed fixture','producer-b':'Producer B · reviewed fixture'};
    await page.getByRole('button',{name:labels[persona]!,exact:false}).click();
    await page.getByRole('navigation',{name:'Market workspace'}).waitFor(); await settled(page);
    return {page,context};
  }
  t.after(()=>assert.deepEqual(errors,[],'The real market browser has no runtime errors'));
  return {...f,api,browser,page};
}
async function switchTo(page: Page,persona: string) {
  await page.getByLabel('Demo participant',{exact:true}).selectOption(persona);
  await page.waitForFunction(value=>document.querySelector('#market-app')?.getAttribute('data-persona')===value && document.querySelector('#market-app')?.getAttribute('aria-busy')==='false',persona);
}
async function route(page: Page,url: string,hash: string) {
  await page.goto(`${url}/#${hash}`); await settled(page);
}
async function submitted(page: Page,operation: Operation,action: () => Promise<unknown>): Promise<Envelope> {
  const response=page.waitForResponse(reply=>reply.url().endsWith(`/commands/${operation}`) && reply.request().method()==='POST');
  await action(); const reply=await response; const receipt=envelope.parse(await reply.json()); await settled(page); return receipt;
}
async function comparePanels(page: Page,url: string) {
  await route(page,url,'market/PANEL-DEMO'); await page.getByRole('table',{name:'Buy demand',exact:false}).waitFor();
}
async function chooseAllocation(page: Page,sellOrderId='panel-sell-a',quantity='8',price='90.00') {
  await page.locator('[data-order-id="panel-buy"] input[type="radio"]').check();
  await page.locator(`[data-order-id="${sellOrderId}"] input[type="radio"]`).check();
  await page.getByLabel('Proposed quantity (each)',{exact:true}).fill(quantity);
  await page.getByLabel('Proposed unit price (USD)',{exact:true}).fill(price);
}
async function postOrder(page: Page,url: string,side: 'buy'|'sell',location: string) {
  await route(page,url,`post/PANEL-DEMO/${side}`);
  await page.getByLabel('Quantity (each)',{exact:true}).fill(side==='buy' ? '2' : '3');
  await page.getByLabel('Unit price (USD)',{exact:true}).fill('105.25');
  if (side==='sell') await page.getByLabel('Supply mode',{exact:true}).selectOption('made_to_order');
  await page.getByLabel('Location',{exact:true}).fill(location);
  await page.getByLabel('Order terms',{exact:true}).fill('Synthetic browser terms; counted receiver acknowledgement.');
  return recordId(ok(await submitted(page,'createMarketOrder',()=>page.getByRole('button',{name:`Post ${side} order`,exact:true}).click())),'orderId');
}
async function confirm(page: Page) {
  await page.getByLabel('I approve these frozen terms for my business.',{exact:true}).check();
  return ok(await submitted(page,'confirmMarketProposal',()=>page.getByRole('button',{name:'Confirm frozen terms',exact:true}).click()));
}
async function report(page: Page,value: number) {
  await page.getByLabel('Report quantity (each)',{exact:true}).fill(String(value));
  await page.getByLabel('Report note',{exact:true}).fill(`Synthetic browser report of ${value} each.`);
  return ok(await submitted(page,'reportMarketFulfillment',()=>page.getByRole('button',{name:'Report fulfillment',exact:true}).click()));
}
async function acknowledge(page: Page,value: number) {
  return ok(await submitted(page,'acknowledgeMarketFulfillment',()=>page.getByRole('button',{name:`Acknowledge ${value} each`,exact:true}).click()));
}
async function snapshot(page: Page,name: string) {
  await page.evaluate(axeSource);
  const results=await page.evaluate(async()=>{
    const checker=(window as unknown as {axe:{run:(root:Document,options:unknown)=>Promise<AxeResults>}}).axe;
    return await checker.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}});
  });
  assert.deepEqual(results.violations.map(v=>({id:v.id,nodes:v.nodes.map(node=>node.target)})),[],`Automated accessibility in ${name}`);
  const width=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));
  assert.ok(width.scroll<=width.client,`No horizontal overflow in ${name}`);
  assert.match(await page.getByRole('banner').innerText(),/Vista Verde/);
  await page.screenshot({path:resolve(artifacts,name),fullPage:true});
}

test('market Chromium: a business posts buy and sell orders, searches items, compares stock/MTO and retains its own records after refresh',async t=>{
  const f=await setup(t),{page}=await f.page('producer-a'),finances=await financialSnapshot(f);
  const buy=await postOrder(page,f.api.url,'buy','Browser both-sided buy destination');
  const sell=await postOrder(page,f.api.url,'sell','Browser both-sided MTO origin');
  await route(page,f.api.url,'orders');
  await page.locator(`[data-work-order-id="${buy}"]`).getByRole('button').click();
  assert.match(await page.getByRole('region',{name:'Selected listing'}).innerText(),/Browser both-sided buy destination/);
  await page.locator(`[data-material-listing-id="${sell}"]`).getByRole('button').click();assert.match(await page.getByRole('region',{name:'Selected listing'}).innerText(),/Browser both-sided MTO origin/);
  await page.reload();await settled(page);await page.locator(`[data-material-listing-id="${sell}"]`).getByRole('button').click();assert.match(await page.getByRole('region',{name:'Selected listing'}).innerText(),/Browser both-sided MTO origin/);
  await comparePanels(page,f.api.url);await page.getByLabel('Search items',{exact:true}).fill('panel');
  await page.getByRole('link',{name:'Demo panel',exact:false}).first().waitFor();
  assert.match(await page.getByRole('table',{name:'Sell supply',exact:false}).innerText(),/Made to order|Made-to-order/i);
  const api=await mcp(f,'producer-a');
  assert.equal((await getOrder(api.call,buy)).side,'buy');assert.equal((await getOrder(api.call,sell)).side,'sell');
  assert.equal((await getOrder(api.call,sell)).unitPrice.minorUnits,10525);
  await snapshot(page,'market-goods-desktop.png');await noFinancialEffects(f,finances);await reconcileMarket(f);
});

test('market Chromium: compare, propose, explicit review by both parties, report/acknowledge 5/3/4 and house navigation persist', {timeout:120000},async t=>{
  const f=await setup(t),{page}=await f.page('buyer'),finances=await financialSnapshot(f),buyer=execute(f,'buyer');
  await comparePanels(page,f.api.url);await chooseAllocation(page);
  const proposed=ok(await submitted(page,'proposeMarketAllocation',()=>page.getByRole('button',{name:'Propose allocation',exact:true}).click()));
  const proposalA=recordId(proposed,'proposalId');
  assert.equal((await getProposal(buyer,proposalA)).buyerApproved,false);
  assert.equal((await getOrder(buyer,'panel-buy')).remainingQuantity.value,12);
  assert.equal(await page.getByLabel('I approve these frozen terms for my business.',{exact:true}).isChecked(),false);
  await snapshot(page,'market-proposal-desktop.png');await confirm(page);
  assert.equal((await f.pool.query('SELECT count(*) FROM market_commitments')).rows[0].count,'0');
  await switchTo(page,'producer-a');await route(page,f.api.url,`proposal/${proposalA}`);
  const commitmentA=recordId(await confirm(page),'commitmentId');
  await route(page,f.api.url,`commitment/${commitmentA}`);await report(page,5);
  assert.equal((await getCommitment(buyer,commitmentA)).acknowledgedQuantity.value,0);
  await switchTo(page,'buyer');await route(page,f.api.url,`commitment/${commitmentA}`);await acknowledge(page,5);
  assert.equal((await getCommitment(buyer,commitmentA)).remainingQuantity.value,3);
  await page.reload();await settled(page);await snapshot(page,'market-partial-fulfillment-desktop.png');
  await switchTo(page,'producer-a');await route(page,f.api.url,`commitment/${commitmentA}`);await report(page,3);
  await switchTo(page,'buyer');await route(page,f.api.url,`commitment/${commitmentA}`);await acknowledge(page,3);
  await comparePanels(page,f.api.url);await chooseAllocation(page,'panel-sell-b','4','95.00');
  const proposalB=recordId(ok(await submitted(page,'proposeMarketAllocation',()=>page.getByRole('button',{name:'Propose allocation',exact:true}).click())),'proposalId');
  await confirm(page);await switchTo(page,'producer-b');await route(page,f.api.url,`proposal/${proposalB}`);
  const commitmentB=recordId(await confirm(page),'commitmentId');
  await route(page,f.api.url,`commitment/${commitmentB}`);await report(page,4);
  await switchTo(page,'buyer');await route(page,f.api.url,`commitment/${commitmentB}`);await acknowledge(page,4);
  for (const id of [commitmentA,commitmentB]) assert.equal((await getCommitment(buyer,id)).state,'completed');
  assert.equal((await getOrder(buyer,'panel-buy')).acknowledgedQuantity.value,12);
  await route(page,f.api.url,'house');await snapshot(page,'market-house-desktop.png');
  const project=await getProject(buyer);assert.equal(project.wholeHouseOrder.allocatedQuantity.value,0);assert.equal(project.wholeHouseOrder.acknowledgedQuantity.value,0);
  assert.match(await page.locator('main').innerText(),/Manual|manual/);await page.reload();await settled(page);
  assert.equal((await getOrder(buyer,'panel-buy')).remainingQuantity.value,0);
  await noFinancialEffects(f,finances);await reconcileMarket(f);
});

test('market Chromium: last-quantity stale confirmation and a tampered unit show real server errors without allocation',async t=>{
  const f=await setup(t),buyer=execute(f,'buyer');
  const stale=await propose(f,proposalInput('browser-stale'));await approve(f,stale,'buyer');
  const {page}=await f.page('producer-a');await route(page,f.api.url,`proposal/${stale}`);
  // Consume the same supply through a separate valid agreement after this UI read.
  await commit(f,proposalInput('browser-winner'));
  await page.getByLabel('I approve these frozen terms for my business.',{exact:true}).check();
  const rejected=await submitted(page,'confirmMarketProposal',()=>page.getByRole('button',{name:'Confirm frozen terms',exact:true}).click());
  assert.equal(rejected.ok,false);if(!rejected.ok)assert.equal(rejected.code,'ORDER_UNAVAILABLE');
  assert.match(await page.locator('.market-notice').innerText(),/remaining|available|quantity|stale/i);
  assert.equal((await f.pool.query('SELECT count(*) FROM market_commitments')).rows[0].count,'1');
  await switchTo(page,'buyer');await comparePanels(page,f.api.url);await chooseAllocation(page,'panel-sell-b','4','95.00');
  await page.route('**/commands/proposeMarketAllocation',async request=>{
    const input=request.request().postDataJSON();await request.continue({postData:JSON.stringify({...input,quantity:{value:4,unit:'kg'}})});
  });
  const invalid=await submitted(page,'proposeMarketAllocation',()=>page.getByRole('button',{name:'Propose allocation',exact:true}).click());
  assert.equal(invalid.ok,false);if(!invalid.ok)assert.equal(invalid.code,'VALIDATION_FAILED');
  assert.match(await page.locator('.market-notice').innerText(),/valid|unit|each/i);
  await page.unroute('**/commands/proposeMarketAllocation');
  assert.equal((await getOrder(buyer,'panel-buy')).allocatedQuantity.value,8);await reconcileMarket(f);
});

test('market Chromium: double submit plus a committed lost reply retries the exact saved key and terms after reload',async t=>{
  const f=await setup(t),{page}=await f.page('producer-a'),finances=await financialSnapshot(f);
  await route(page,f.api.url,'post/PANEL-DEMO/sell');
  await page.getByLabel('Quantity (each)',{exact:true}).fill('3');await page.getByLabel('Unit price (USD)',{exact:true}).fill('101.50');
  await page.getByLabel('Location',{exact:true}).fill('Lost reply synthetic origin');
  await page.getByLabel('Order terms',{exact:true}).fill('Frozen original order terms.');
  const inputs: unknown[]=[];
  page.on('request',request=>{if(request.url().endsWith('/commands/createMarketOrder'))inputs.push(request.postDataJSON());});
  await page.route('**/commands/createMarketOrder',async request=>{await request.fetch();await request.abort('failed');});
  await page.getByRole('button',{name:'Post sell order',exact:true}).evaluate(button=>{
    const form=button.closest('form')!;form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  });
  await page.getByRole('button',{name:'Retry saved request',exact:true}).waitFor();
  await settled(page);
  assert.equal(inputs.length,1,'A double submit sends one durable intent');
  const stored=(await f.pool.query("SELECT result FROM market_idempotency WHERE operation='createMarketOrder' AND key=$1",[(inputs[0] as {idempotencyKey:string}).idempotencyKey])).rows[0].result;
  const orderId=recordId(ok(stored),'orderId');
  await page.unroute('**/commands/createMarketOrder');await page.reload();await page.getByRole('button',{name:'Retry saved request',exact:true}).waitFor();
  const replay=ok(await submitted(page,'createMarketOrder',()=>page.getByRole('button',{name:'Retry saved request',exact:true}).click()));
  assert.equal(recordId(replay,'orderId'),orderId);assert.equal(inputs.length,2);assert.deepEqual(inputs[1],inputs[0]);
  assert.equal((await f.pool.query("SELECT count(*) FROM market_orders WHERE location='Lost reply synthetic origin'")).rows[0].count,'1');
  assert.equal(await page.getByRole('button',{name:'Retry saved request',exact:true}).count(),0);
  await noFinancialEffects(f,finances);await reconcileMarket(f);
});

test('market Chromium: pending confirmation keeps its persona, and a late committed reply respects newer navigation',async t=>{
  const f=await setup(t);const proposalId=await propose(f,proposalInput('browser-owned-intent'));await approve(f,proposalId,'buyer');
  const {page}=await f.page('producer-a');await route(page,f.api.url,`proposal/${proposalId}`);
  let committed!:()=>void,release!:()=>void;const didCommit=new Promise<void>(resolve=>{committed=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});t.after(()=>release());
  await page.route('**/commands/confirmMarketProposal',async request=>{const response=await request.fetch();committed();await held;await request.fulfill({response});});
  await page.getByLabel('I approve these frozen terms for my business.',{exact:true}).check();
  await page.getByRole('button',{name:'Confirm frozen terms',exact:true}).click();await didCommit;
  assert.equal(await page.getByLabel('Demo participant',{exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'Sign out',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'Retry saved request',exact:true}).count(),0);
  await page.getByRole('navigation',{name:'Market workspace'}).locator('a[href="#orders"]').click();await page.waitForURL('**/#orders');
  release();await settled(page);await page.unroute('**/commands/confirmMarketProposal');
  assert.equal(new URL(page.url()).hash,'#orders');assert.equal((await f.pool.query('SELECT count(*) FROM market_commitments')).rows[0].count,'1');
  await reconcileMarket(f);
});

test('market Chromium: an obsolete private proposal reply cannot populate a new participant; denied deep links disclose no private record',async t=>{
  const f=await setup(t),proposalId=await propose(f,proposalInput('browser-private-view')), {page}=await f.page('buyer');
  let captured!:()=>void,release!:()=>void;const received=new Promise<void>(resolve=>{captured=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});t.after(()=>release());
  let first=true;
  await page.route('**/queries/getMarketProposal',async request=>{
    const response=await request.fetch();if(!first){await request.fulfill({response});return;}first=false;captured();await held;await request.fulfill({response});
  });
  await page.evaluate(id=>{location.hash=`proposal/${id}`;},proposalId);await received;
  await switchTo(page,'producer-b');const delivered=page.waitForResponse(response=>response.url().endsWith('/queries/getMarketProposal'));
  release();await(await delivered).finished();await delay(50);await page.unroute('**/queries/getMarketProposal');
  assert.equal((await page.locator('main').innerText()).includes(proposalId),false);
  assert.equal(await page.getByRole('button',{name:'Confirm frozen terms',exact:true}).count(),0);
  await route(page,f.api.url,`proposal/${proposalId}`);
  assert.match(await page.locator('main').innerText(),/unavailable|permission|permitted/i);
  assert.equal(await page.getByLabel('I approve these frozen terms for my business.',{exact:true}).count(),0);await reconcileMarket(f);
});

test('market Chromium mobile: branded comparison/proposal/house views pass axe, keyboard consent and route-preserving skip navigation',async t=>{
  const f=await setup(t),{page}=await f.page('buyer',{width:390,height:844});
  await comparePanels(page,f.api.url);await snapshot(page,'market-goods-mobile.png');await chooseAllocation(page);
  const proposalId=recordId(ok(await submitted(page,'proposeMarketAllocation',()=>page.getByRole('button',{name:'Propose allocation',exact:true}).click())),'proposalId');
  await snapshot(page,'market-proposal-mobile.png');
  await page.getByLabel('I approve these frozen terms for my business.',{exact:true}).check();
  await page.getByLabel('I approve these frozen terms for my business.',{exact:true}).focus();await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button',{name:'Confirm frozen terms',exact:true}).evaluate(button=>button===document.activeElement),true);
  const hash=new URL(page.url()).hash;await page.getByRole('link',{name:'Skip to market workspace',exact:true}).focus();await page.keyboard.press('Enter');
  assert.equal(new URL(page.url()).hash,hash);assert.equal(await page.locator('#market-app').evaluate(main=>main===document.activeElement),true);
  await page.keyboard.press('Tab');await route(page,f.api.url,'house');await snapshot(page,'market-house-mobile.png');
  assert.equal((await getProposal(execute(f,'buyer'),proposalId)).buyerApproved,false,'Keyboard navigation alone cannot approve a proposal');await reconcileMarket(f);
});
