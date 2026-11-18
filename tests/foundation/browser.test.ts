import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import type { AxeResults } from 'axe-core';
import { mkdirSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import { draft,publication } from '../../packages/db/src/fixtures.ts';
import { fixture,ok } from './helpers.ts';
import { web,mcp } from './web-helpers.ts';
const axeSource=readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'),'utf8');
const artifacts=resolve(process.env.VV_WEB_ARTIFACTS ?? 'web-artifacts'); mkdirSync(artifacts,{ recursive:true });
async function setup(t: Parameters<typeof fixture>[0]) {
  const f=await fixture(t); const api=await web(f); const browser=await chromium.launch(); f.cleanupWith(() => browser.close());
  const errors: string[]=[];
  async function page(persona: string,viewport={ width:1440,height:1080 }) {
    const context=await browser.newContext({ viewport }); const page=await context.newPage();
    page.on('pageerror',e => errors.push(e.message));
    await page.goto(`${api.url}/legacy`); await page.getByLabel('Demo role',{ exact:true }).selectOption(persona);
    await page.getByRole('button',{ name:'Open workspace',exact:true }).click();
    await page.getByRole('navigation',{ name:'Workspace' }).waitFor(); await settled(page);
    return { page,context };
  }
  t.after(() => assert.deepEqual(errors,[],'No browser runtime errors'));
  return { ...f,api,browser,page };
}
async function settled(page: Page) { await page.locator('#app[aria-busy="false"]').waitFor(); }
async function switchTo(page: Page,persona: string) {
  await page.getByLabel('Demo role',{ exact:true }).selectOption(persona);
  await page.waitForFunction(p => (document.querySelector('#app') as HTMLElement | null)?.dataset.persona === p && document.querySelector('#app')?.getAttribute('aria-busy') === 'false',persona);
}
async function createDraft(page: Page,title: string) {
  await page.getByRole('link',{ name:'Create draft',exact:true }).click(); await page.getByLabel('Intended use',{ exact:true }).fill(title);
  await page.getByRole('button',{ name:'Create synthetic draft',exact:true }).click();
  await page.getByRole('heading',{ name:title,exact:true }).waitFor(); await settled(page);
  return new URL(page.url()).hash.split('/')[1]!;
}
async function publish(page: Page,title: string,compensation='600.00',price='25.00') {
  await switchTo(page,'buyer'); await page.getByRole('link',{ name:'Review requirement',exact:false }).first().click();
  await page.getByRole('heading',{ name:title,exact:true }).waitFor();
  await page.getByLabel('Total compensation (USD)',{ exact:true }).fill(compensation);
  await page.getByLabel('Separate slot purchase price (USD)',{ exact:true }).fill(price);
  await page.getByLabel('I reviewed the released specification', { exact:false }).check();
  await page.getByRole('button',{ name:'Reserve funds & publish',exact:true }).click(); await settled(page);
}
async function openPurchase(page: Page) {
  await page.getByRole('link',{ name:'Inspect terms',exact:false }).first().click();
  await page.getByRole('button',{ name:'Purchase synthetic slot',exact:true }).waitFor(); await settled(page);
  await page.getByLabel('I accept the frozen specification',{ exact:false }).check();
}
function issues(page: Page) { return page.locator('#notice'); }
async function snapshot(page: Page,name: string) {
  await page.evaluate(axeSource);
  const results=await page.evaluate(async () => { const checker=(window as unknown as { axe:{ run:(root: Document,options: unknown)=>Promise<AxeResults> } }).axe; return await checker.run(document,{ runOnly:{ type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'] } }); });
  assert.deepEqual(results.violations.map(v => ({ id:v.id,nodes:v.nodes.map(n => n.target) })),[],`Automated accessibility violations in ${name}`);
  await page.screenshot({ path:resolve(artifacts,name),fullPage:true });
  const width=await page.evaluate(() => ({ scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth }));
  assert.ok(width.scroll<=width.client,'No horizontal overflow');
}

test('Chromium: agent draft, human reservation, eligible purchase, frozen receipt, navigation and refresh persist',async t => {
  const f=await setup(t); const { page }=await f.page('buyer-agent'); const title='Housing panels · local browser journey';
  const id=await createDraft(page,title); await publish(page,title);
  await page.getByRole('heading',{ name:'Published allocations',exact:true }).waitFor();
  await snapshot(page,'buyer-desktop.png');
  await switchTo(page,'producer-a'); await snapshot(page,'marketplace-desktop.png');
  await openPurchase(page); await snapshot(page,'slot-desktop.png');
  await page.getByRole('button',{ name:'Purchase synthetic slot',exact:true }).click();
  await page.getByRole('heading',{ name:'Allocation recorded.',exact:true }).waitFor(); await settled(page);
  const commitment=new URL(page.url()).hash.split('/')[1]!; await snapshot(page,'commitment-desktop.png');
  await page.reload(); await page.getByRole('heading',{ name:'Allocation recorded.',exact:true }).waitFor();
  await page.getByRole('link',{ name:'Your commitments',exact:true }).click(); await page.getByRole('link',{ name:'View commitment',exact:false }).waitFor();
  await page.getByRole('link',{ name:'View commitment',exact:false }).click(); await page.getByRole('heading',{ name:'Allocation recorded.',exact:true }).waitFor();
  const agent=await mcp(f,'producer-a'); const receipt=ok(await agent.call('getCommitment',{ commitmentId:commitment })); assert.equal(receipt.recordIds.requirementId,id);
  assert.equal((await f.pool.query("SELECT reserved FROM accounts WHERE id='buyer-funds'")).rows[0].reserved,'60000');
  assert.equal((await f.pool.query('SELECT count(*) FROM commitments')).rows[0].count,'1'); await f.reconcile();
});

test('Chromium: two producer contexts on the last slot produce exactly one success and stale loser stays uncharged',async t => {
  const f=await setup(t); await f.publish('last'); const a=await f.page('producer-a'),b=await f.page('producer-b');
  await Promise.all([openPurchase(a.page),openPurchase(b.page)]);
  await Promise.all([a.page.getByRole('button',{ name:'Purchase synthetic slot',exact:true }).click(),b.page.getByRole('button',{ name:'Purchase synthetic slot',exact:true }).click()]);
  await Promise.all([settled(a.page),settled(b.page)]);
  const results=await Promise.all([a.page.getByRole('heading',{ name:'Allocation recorded.',exact:true }).count(),b.page.getByRole('heading',{ name:'Allocation recorded.',exact:true }).count()]); assert.equal(results[0]!+results[1]!,1);
  const loser=results[0] ? b.page : a.page; assert.match(await issues(loser).innerText(),/no longer available/);
  assert.equal((await f.pool.query('SELECT count(*) FROM commitments')).rows[0].count,'1'); assert.equal((await f.pool.query('SELECT count(*) FROM journal_entries')).rows[0].count,'2');
  const balances=(await f.pool.query("SELECT balance FROM accounts WHERE id IN ('producer-a-funds','producer-b-funds') ORDER BY balance")).rows.map(r => r.balance); assert.deepEqual(balances,['99900','100000']);
  await loser.reload(); await settled(loser); assert.equal(await loser.getByRole('button',{ name:'Purchase synthetic slot',exact:true }).count(),0); await f.reconcile();
});

test('Chromium: double submit and lost response retry across refresh return one durable purchase',async t => {
  const f=await setup(t); await f.publish('last'); const { page }=await f.page('producer-a'); await openPurchase(page);
  // Let the server commit, then sever only the client reply: an actual unknown-outcome retry.
  await page.route('**/commands/purchaseSlot',async route => { await route.fetch(); await route.abort('failed'); });
  await page.evaluate(() => { const form=document.querySelector('#purchase-form')!; form.dispatchEvent(new Event('submit',{ bubbles:true,cancelable:true })); form.dispatchEvent(new Event('submit',{ bubbles:true,cancelable:true })); });
  await page.getByRole('button',{ name:'Retry saved request',exact:true }).waitFor();
  assert.equal((await f.pool.query('SELECT count(*) FROM commitments')).rows[0].count,'1');
  await page.unroute('**/commands/purchaseSlot'); await page.reload(); await page.getByRole('button',{ name:'Retry saved request',exact:true }).waitFor();
  // A grant-scope change can deny a historical receipt without disproving the earlier commit.
  await f.pool.query('UPDATE grants SET requirement_scopes=ARRAY[]::text[] WHERE id=$1',[f.context('producer-a').grantId]);
  await page.getByRole('button',{ name:'Retry saved request',exact:true }).click(); await settled(page);
  assert.ok(await page.evaluate(() => sessionStorage.getItem('vv.pending.producer-a')),'Unknown committed intent remains recoverable after permission denial');
  await f.pool.query("UPDATE grants SET requirement_scopes=ARRAY['*'] WHERE id=$1",[f.context('producer-a').grantId]);
  await page.getByRole('button',{ name:'Retry saved request',exact:true }).click(); await page.getByRole('heading',{ name:'Allocation recorded.',exact:true }).waitFor();
  assert.equal((await f.pool.query('SELECT count(*) FROM commitments')).rows[0].count,'1'); assert.equal((await f.pool.query('SELECT count(*) FROM journal_entries')).rows[0].count,'2');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('vv.pending.producer-a')),null); await f.reconcile();
});

test('Chromium: reload before a committed reply preserves original recovery even if authority later denies it',async t => {
  const f=await setup(t); await f.publish('last'); const { page }=await f.page('producer-a'); await openPurchase(page);
  let committed!: () => void,release!: () => void;
  const didCommit=new Promise<void>(resolve => { committed=resolve; });
  const heldReply=new Promise<void>(resolve => { release=resolve; });
  await page.route('**/commands/purchaseSlot',async route => {
    await route.fetch(); committed(); await heldReply;
    await route.abort('failed').catch(() => undefined); // Navigation may already have cancelled this old document's request.
  });
  await page.getByRole('button',{ name:'Purchase synthetic slot',exact:true }).click(); await didCommit;
  const original=await page.evaluate(() => JSON.parse(sessionStorage.getItem('vv.pending.producer-a')!));
  assert.equal(original.uncertain,undefined,'The first document has not received or caught any reply');
  assert.equal((await f.pool.query('SELECT count(*) FROM commitments')).rows[0].count,'1');
  await page.reload(); await page.getByRole('button',{ name:'Retry saved request',exact:true }).waitFor();
  release(); await page.unroute('**/commands/purchaseSlot');
  await f.pool.query('UPDATE grants SET requirement_scopes=ARRAY[]::text[] WHERE id=$1',[f.context('producer-a').grantId]);
  await page.getByRole('button',{ name:'Retry saved request',exact:true }).click(); await settled(page);
  const recovered=await page.evaluate(() => JSON.parse(sessionStorage.getItem('vv.pending.producer-a')!));
  assert.deepEqual(recovered.input,original.input,'A later denial preserves the original payload and key'); assert.equal(recovered.uncertain,true);
  await f.pool.query("UPDATE grants SET requirement_scopes=ARRAY['*'] WHERE id=$1",[f.context('producer-a').grantId]);
  await page.getByRole('button',{ name:'Retry saved request',exact:true }).click(); await page.getByRole('heading',{ name:'Allocation recorded.',exact:true }).waitFor();
  assert.equal((await f.pool.query('SELECT count(*) FROM journal_entries')).rows[0].count,'2');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('vv.pending.producer-a')),null); await f.reconcile();
});

test('Chromium: pagination coalesces double clicks and discards replies after persona and route changes',async t => {
  const f=await setup(t);
  for (let index=0;index<21;index++) {
    const created=ok(await f.application.execute('createRequirementDraft',{ ...draft(`page-${index}`),intendedUse:`Pagination synthetic demand ${index}` },f.context('buyer-agent')));
    ok(await f.application.execute('publishRequirement',publication(created.recordIds.requirementId!,`page-slot-${index}`),f.context('buyer')));
  }
  const { page }=await f.page('buyer');
  async function delayedPage(operation: string) {
    let captured!: () => void,release!: () => void; let calls=0;
    const received=new Promise<void>(resolve => { captured=resolve; }),held=new Promise<void>(resolve => { release=resolve; });
    await page.route(`**/queries/${operation}`,async route => {
      if (!route.request().postDataJSON().cursor) { await route.continue(); return; }
      calls++; const response=await route.fetch(); captured(); await held; await route.fulfill({ response });
    });
    await page.locator('#more').evaluate(button => { button.dispatchEvent(new MouseEvent('click',{ bubbles:true })); button.dispatchEvent(new MouseEvent('click',{ bubbles:true })); });
    await received;
    return { release:async () => {
      const delivered=page.waitForResponse(response => response.url().endsWith(`/queries/${operation}`) && Boolean(response.request().postDataJSON().cursor));
      release(); await (await delivered).finished(); await delay(50);
      await page.unroute(`**/queries/${operation}`); assert.equal(calls,1,'One page fetch for a double click');
    } };
  }
  assert.equal(await page.locator('#listing .card').count(),20);
  const buyerPage=await delayedPage('getWorkspace'); await switchTo(page,'producer-a');
  await buyerPage.release(); assert.equal(await page.locator('#listing .card').count(),20);
  assert.equal(await page.getByRole('link',{ name:'Review requirement',exact:false }).count(),0,'A late buyer page cannot populate the producer listing');
  assert.equal(await page.getByRole('button',{ name:'Load more slots',exact:true }).isVisible(),true,'A stale buyer cursor cannot hide producer pagination');
  const producerPage=await delayedPage('listAvailableSlots');
  await page.getByRole('link',{ name:'Your commitments',exact:true }).click(); await settled(page);
  await producerPage.release(); assert.equal(await page.locator('#listing .card').count(),0,'A late slot page cannot populate commitment navigation');
  assert.equal(await page.getByRole('button',{ name:'Load more records',exact:true }).isVisible(),false);
  await page.getByRole('link',{ name:'Available slots',exact:true }).click(); await settled(page);
  const loaded=page.waitForResponse(response => response.url().endsWith('/queries/listAvailableSlots') && Boolean(response.request().postDataJSON().cursor));
  await page.getByRole('button',{ name:'Load more slots',exact:true }).click(); await (await loaded).finished();
  await page.waitForFunction(() => document.querySelectorAll('#listing .card').length === 21);
  assert.equal(await page.getByRole('button',{ name:'Load more slots',exact:true }).isVisible(),false); await f.reconcile();
});

test('Chromium: cross-requirement shortfall, producer shortfall and stale eligibility fail without mutations',async t => {
  const f=await setup(t); await f.publish('reserved',600000); const created=ok(await f.application.execute('createRequirementDraft',{ ...draft('shortfall'),intendedUse:'Funding shortfall fixture' },f.context('buyer-agent')));
  const { page }=await f.page('buyer'); await page.goto(`${f.api.url}/legacy#requirement/${created.recordIds.requirementId}`); await page.getByLabel('Total compensation (USD)',{ exact:true }).fill('6000.00'); await page.getByLabel('I reviewed the released specification',{ exact:false }).check();
  await page.getByRole('button',{ name:'Reserve funds & publish',exact:true }).click(); await settled(page); assert.match(await issues(page).innerText(),/Insufficient synthetic funds/);
  assert.equal((await f.pool.query('SELECT state FROM requirements WHERE id=$1',[created.recordIds.requirementId])).rows[0].state,'draft'); assert.equal((await f.pool.query('SELECT count(*) FROM slots')).rows[0].count,'1');
  await switchTo(page,'producer-a'); await openPurchase(page); await f.pool.query("UPDATE accounts SET balance=0 WHERE id='producer-a-funds'");
  await page.getByRole('button',{ name:'Purchase synthetic slot',exact:true }).click(); await settled(page); assert.match(await issues(page).innerText(),/Insufficient synthetic funds/);
  assert.equal((await f.pool.query('SELECT count(*) FROM commitments')).rows[0].count,'0');
  await f.pool.query("UPDATE capabilities SET evidence_status='self_declared' WHERE organization_id='producer-a-org'"); await page.getByLabel('I accept the frozen specification',{ exact:false }).check(); await page.getByRole('button',{ name:'Purchase synthetic slot',exact:true }).click(); await settled(page); assert.match(await issues(page).innerText(),/unavailable to the current demo grant/);
  assert.equal((await f.pool.query('SELECT count(*) FROM journal_entries')).rows[0].count,'0'); await page.getByRole('link',{ name:'Available slots',exact:true }).click(); await page.getByRole('heading',{ name:'No eligible slots available',exact:true }).waitFor(); await f.reconcile();
});

test('Chromium: forbidden object, forged session write, grant revocation and dynamic content remain safe',async t => {
  const f=await setup(t); const a=await f.page('buyer-agent');
  const title='<img src=x onerror=alert(1)> synthetic text'; const ownedId=await createDraft(a.page,title); assert.equal(await a.page.locator('main img').count(),0);
  const other=ok(await f.application.execute('createRequirementDraft',{ ...draft('foreign'),intendedUse:'PRIVATE FOREIGN TITLE' },f.context('other-agent')));
  await a.page.goto(`${f.api.url}/legacy#requirement/${other.recordIds.requirementId}`); await a.page.getByRole('heading',{ name:'This view is unavailable',exact:true }).waitFor(); assert.equal((await a.page.locator('main').innerText()).includes('PRIVATE FOREIGN TITLE'),false);
  const unauthorized=await a.page.evaluate(async id => { const session=await (await fetch('/session')).json(); const result=await fetch('/commands/publishRequirement',{ method:'POST',headers:{ 'content-type':'application/json','x-csrf-token':session.csrf },body:JSON.stringify({ idempotencyKey:'forbidden-agent-publication',requirementId:id,expectedRecordVersion:1,requirementRevision:1,slots:[{ slotId:'forged',lineId:'components',quantity:{ value:12,unit:'component' },specificationId:'housing-panel',specificationRevision:1,termsId:'synthetic-v1',termsRevision:1,compensation:{ minorUnits:6000,currency:'USD' },slotPrice:{ minorUnits:100,currency:'USD' },expiresAt:new Date(Date.now()+60000).toISOString() }] }) }); return { status:result.status,body:await result.json() }; },ownedId); assert.equal(unauthorized.status,403); assert.equal(unauthorized.body.code,'FORBIDDEN');
  const forged=await a.page.evaluate(async () => { const response=await fetch('/commands/publishRequirement',{ method:'POST',headers:{ 'content-type':'application/json' },body:'{}' }); return response.status; }); assert.equal(forged,403);
  await f.pool.query('UPDATE grants SET revoked=true WHERE id=$1',[f.context('buyer-agent').grantId]); await a.page.reload(); await a.page.getByRole('heading',{ name:'Local demonstration unavailable',exact:true }).waitFor(); assert.equal((await f.pool.query('SELECT count(*) FROM slots')).rows[0].count,'0');
});

test('Chromium mobile: responsive terms, keyboard flow, scoped release and MCP-created records visible',async t => {
  const f=await setup(t); const agent=await mcp(f,'buyer-agent'),buyer=await mcp(f,'buyer');
  const created=ok(await agent.call('createRequirementDraft',{ ...draft('mobile'),intendedUse:'Housing component mobile allocation' })); const id=created.recordIds.requirementId!;
  ok(await buyer.call('publishRequirement',publication(id,'mobile-slot',60000,new Date(Date.now()+86400000).toISOString())));
  const mobile=await f.page('producer-a',{ width:390,height:844 }); await snapshot(mobile.page,'marketplace-mobile.png'); await openPurchase(mobile.page); await snapshot(mobile.page,'slot-mobile.png');
  await mobile.page.getByLabel('I accept the frozen specification',{ exact:false }).focus(); await mobile.page.keyboard.press('Tab');
  assert.equal(await mobile.page.getByRole('button',{ name:'Purchase synthetic slot',exact:true }).evaluate(e => e === document.activeElement),true,'Tab moves from acceptance to the purchase control');
  const human=await f.page('buyer'); await human.page.goto(`${f.api.url}/legacy#slot/mobile-slot`); await human.page.getByRole('button',{ name:'Withdraw unpurchased slot',exact:true }).click(); await settled(human.page);
  assert.equal((await f.pool.query("SELECT reserved FROM accounts WHERE id='buyer-funds'")).rows[0].reserved,'0'); assert.equal((await f.pool.query("SELECT state FROM slots WHERE id='mobile-slot'")).rows[0].state,'withdrawn');
  // A stale producer view submits to the same server authority and cannot allocate released money.
  await mobile.page.getByRole('button',{ name:'Purchase synthetic slot',exact:true }).click(); await settled(mobile.page); assert.match(await issues(mobile.page).innerText(),/no longer available/); await snapshot(mobile.page,'stale-mobile.png'); await f.reconcile();
});

test('Chromium: expired slot deep link allows only buyer cleanup and releases held compensation once',async t => {
  const f=await setup(t); const expiry=Date.now()+2500;
  const { requirementId }=await f.publish('expiry',6000,'housing-panel',new Date(expiry).toISOString());
  await delay(Math.max(1,expiry-Date.now()+30));
  const buyer=await f.page('buyer'); await buyer.page.goto(`${f.api.url}/legacy#slot/expiry/${requirementId}`);
  await buyer.page.getByRole('button',{ name:'Process expiry & release',exact:true }).waitFor();
  await buyer.page.reload(); await buyer.page.getByRole('button',{ name:'Process expiry & release',exact:true }).click(); await settled(buyer.page);
  assert.equal((await f.pool.query("SELECT state FROM slots WHERE id='expiry'")).rows[0].state,'expired'); assert.equal((await f.pool.query("SELECT reserved FROM accounts WHERE id='buyer-funds'")).rows[0].reserved,'0');
  assert.equal(await buyer.page.getByRole('button',{ name:'Process expiry & release',exact:true }).count(),0); await f.reconcile();
});

test('Chromium React: StrictMode bootstrap coalesces reads, navigation never writes, and focus/skip remain usable',async t => {
  if (process.env.VV_REACT_MODE === 'development') {
    assert.match(readFileSync('dist/apps/web/app.js','utf8'),/react-dom-client\.development/,'Exercise the real development React runtime and effect replay');
  }
  const f=await setup(t),context=await f.browser.newContext(),page=await context.newPage();
  let boot=0,writes=0;
  page.on('request',request => { if (request.url().endsWith('/session') && request.method()==='GET') boot++;if (request.url().includes('/commands/')) writes++; });
  await page.goto(`${f.api.url}/legacy`);await page.getByLabel('Demo role',{ exact:true }).selectOption('buyer-agent');
  await page.getByRole('button',{ name:'Open workspace',exact:true }).click();await settled(page);
  assert.equal(boot,1,'Effect cleanup/setup shares a single session bootstrap');
  for (let index=0;index<3;index++) {
    await page.getByRole('link',{ name:'Create draft',exact:true }).click();await page.getByLabel('Intended use',{ exact:true }).waitFor();await settled(page);
    assert.equal(await page.locator('#app').evaluate(element => element===document.activeElement),true,`Route completion focuses the main landmark (round trip ${index+1})`);
    const hash=new URL(page.url()).hash;
    await page.getByRole('link',{ name:'Skip to workspace',exact:true }).focus();await page.keyboard.press('Enter');
    assert.equal(new URL(page.url()).hash,hash,'Skip navigation does not rewrite the route');
    assert.equal(await page.locator('#app').evaluate(element => element===document.activeElement),true);
    await page.getByRole('link',{ name:'Requirements',exact:true }).click();
    // aria-busy may still describe the outgoing draft before hashchange runs.
    // Observe the destination view before beginning the next navigation/focus check.
    await page.getByRole('heading',{ name:'Shared requirements',exact:true }).waitFor();await settled(page);
  }
  assert.equal(writes,0);assert.equal((await f.pool.query('SELECT count(*) FROM requirements')).rows[0].count,'0');
  await snapshot(page,'react-keyboard-desktop.png');await f.reconcile();
});

test('Chromium React: in-flight command owns identity/recovery and its late reply respects newer navigation',async t => {
  const f=await setup(t);await f.publish('react-owned-write');const { page }=await f.page('producer-a');await openPurchase(page);
  let committed!:()=>void,release!:()=>void;
  const didCommit=new Promise<void>(resolve=>{committed=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/commands/purchaseSlot',async route=>{const response=await route.fetch();committed();await held;await route.fulfill({response});});
  await page.getByRole('button',{ name:'Purchase synthetic slot',exact:true }).click();await didCommit;
  assert.equal(await page.getByLabel('Demo role',{exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'End demo session',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'Retry saved request',exact:true}).count(),0,'Do not offer recovery before the first outcome');
  assert.ok(await page.evaluate(()=>sessionStorage.getItem('vv.pending.producer-a')),'Intent is persisted before dispatch');
  await page.getByRole('link',{name:'Your commitments',exact:true}).click();await page.getByRole('heading',{name:'Your producer commitments',exact:true}).waitFor();
  release();await settled(page);await page.unroute('**/commands/purchaseSlot');
  assert.equal(new URL(page.url()).hash,'#commitments','Late result cannot replace the newer route');
  assert.equal(await page.locator('#listing .card').count(),1);assert.equal(await page.evaluate(()=>sessionStorage.getItem('vv.pending.producer-a')),null);
  assert.equal((await f.pool.query('SELECT count(*) FROM commitments')).rows[0].count,'1');await f.reconcile();
});

test('Chromium React: obsolete detail failure cannot overwrite a new persona or show foreign content',async t => {
  const f=await setup(t);await f.publish('react-current');const foreign=ok(await f.application.execute('createRequirementDraft',{...draft('react-foreign'),intendedUse:'PRIVATE REACT FOREIGN TITLE'},f.context('other-agent')));
  const {page}=await f.page('buyer');let received!:()=>void,release!:()=>void;
  const captured=new Promise<void>(resolve=>{received=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/queries/getRequirement',async route=>{if(route.request().postDataJSON().requirementId!==foreign.recordIds.requirementId){await route.continue();return;}const response=await route.fetch();received();await held;await route.fulfill({response});});
  await page.evaluate(id=>{location.hash='requirement/'+id;},foreign.recordIds.requirementId!);await captured;
  await switchTo(page,'producer-a');await page.getByRole('heading',{name:'Available production slots',exact:true}).waitFor();
  const delivered=page.waitForResponse(response=>response.url().endsWith('/queries/getRequirement')&&response.request().postDataJSON().requirementId===foreign.recordIds.requirementId);
  release();await(await delivered).finished();await delay(50);await page.unroute('**/queries/getRequirement');
  assert.equal(await page.locator('#notice').isVisible(),false);assert.equal((await page.locator('main').innerText()).includes('PRIVATE REACT FOREIGN TITLE'),false);
  assert.equal(await page.getByRole('heading',{name:'Available production slots',exact:true}).count(),1);await f.reconcile();
});

test('Chromium React: recovery storage failure blocks dispatch and restored storage permits one purchase',async t => {
  const f=await setup(t);await f.publish('react-storage');const {page}=await f.page('producer-a');await openPurchase(page);let writes=0;
  page.on('request',request=>{if(request.url().includes('/commands/purchaseSlot'))writes++;});
  await page.evaluate(()=>{const original=Storage.prototype.setItem;(window as unknown as {vvRestoreStorage:()=>void}).vvRestoreStorage=()=>{Storage.prototype.setItem=original;};Storage.prototype.setItem=function(key,value){if(key.startsWith('vv.pending.'))throw new Error('Synthetic storage quota failure');original.call(this,key,value);};});
  await page.getByRole('button',{name:'Purchase synthetic slot',exact:true}).click();await page.locator('#notice').getByText('No command was sent.',{exact:false}).waitFor();
  assert.equal(writes,0);assert.equal((await f.pool.query('SELECT count(*) FROM commitments')).rows[0].count,'0');
  await page.evaluate(()=>(window as unknown as {vvRestoreStorage:()=>void}).vvRestoreStorage());
  await page.getByRole('button',{name:'Purchase synthetic slot',exact:true}).click();await page.getByRole('heading',{name:'Allocation recorded.',exact:true}).waitFor();await settled(page);
  assert.equal(writes,1);assert.equal((await f.pool.query('SELECT count(*) FROM commitments')).rows[0].count,'1');await f.reconcile();
});

test('Chromium React: purchase refresh never coalesces a pending pre-write workspace snapshot',async t => {
  const f=await setup(t);await f.publish('react-read-epoch');const {page}=await f.page('producer-a');await openPurchase(page);
  let queued!:()=>void,releaseWrite!:()=>void,captured!:()=>void,releaseRead!:()=>void,reads=0;
  const writeQueued=new Promise<void>(resolve=>{queued=resolve;}),writeHeld=new Promise<void>(resolve=>{releaseWrite=resolve;});
  const readCaptured=new Promise<void>(resolve=>{captured=resolve;}),readHeld=new Promise<void>(resolve=>{releaseRead=resolve;});
  t.after(()=>{releaseWrite();releaseRead();});
  await page.route('**/commands/purchaseSlot',async route=>{queued();await writeHeld;const response=await route.fetch();await route.fulfill({response});});
  await page.route('**/queries/getWorkspace',async route=>{
    reads++;if(reads!==1){await route.continue();return;}
    const response=await route.fetch();captured();await readHeld;await route.fulfill({response});
  });
  await page.getByRole('button',{name:'Purchase synthetic slot',exact:true}).click();await writeQueued;
  await page.getByRole('link',{name:'Your commitments',exact:true}).click();await readCaptured;
  assert.equal((await f.pool.query('SELECT count(*) FROM commitments')).rows[0].count,'0','The held read predates purchase');
  releaseWrite();await settled(page);
  assert.equal(reads,2,'Refresh must dispatch despite an obsolete pending read');
  assert.equal(new URL(page.url()).hash,'#commitments');assert.equal(await page.locator('#listing .card').count(),1);
  assert.equal(await page.locator('.metric strong').first().innerText(),'$999.00');
  const delivered=page.waitForResponse(response=>response.url().endsWith('/queries/getWorkspace'));
  releaseRead();await(await delivered).finished();await delay(50);
  assert.equal(await page.locator('.metric strong').first().innerText(),'$999.00');assert.equal(await page.locator('#listing .card').count(),1);
  await f.reconcile();
});

test('Chromium React: denied workspace keeps session recovery and withholds unauthorized projections',async t => {
  const f=await setup(t);await f.publish('react-session-recovery');const {page}=await f.page('buyer-agent');
  await f.pool.query('UPDATE grants SET revoked=true WHERE id=$1',[f.context('buyer-agent').grantId]);
  await page.getByRole('link',{name:'Create draft',exact:true}).click();await page.getByRole('heading',{name:'This view is unavailable',exact:true}).waitFor();await settled(page);
  assert.equal(await page.locator('.metric').count(),0,'Denied workspace never projects previous funds');
  assert.equal(await page.locator('#listing .card').count(),0);assert.equal(await page.getByLabel('Demo role',{exact:true}).isEnabled(),true);
  assert.equal(await page.getByRole('button',{name:'End demo session',exact:true}).isEnabled(),true);
  await snapshot(page,'react-session-recovery-desktop.png');
  await switchTo(page,'buyer');await page.getByRole('heading',{name:'Shared requirements',exact:true}).waitFor();
  assert.equal(await page.locator('#listing .card').count(),1);assert.equal(await page.locator('.metric').count(),3);
  await page.getByRole('button',{name:'End demo session',exact:true}).click();await page.getByRole('button',{name:'Open workspace',exact:true}).waitFor();
  assert.equal(await page.locator('.metric').count(),0);await f.reconcile();
});
