import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup,route,submitted,snapshot,settled,switchTo} from './market-browser-helpers.ts';
import {ok} from './helpers.ts';
import {syntheticCube} from '../../apps/print-demo/model.ts';
import {financialSnapshot,execute,workOrderInput,responseInput,recordId,getOrder,getCommitment,marketSnapshot} from './market-helpers.ts';

for(const width of [1440,390])test(`persistent print UI ${width}: local metadata, scoped job, drawer consent, partial receipt and reload`,{timeout:120000},async t=>{
 const f=await setup(t),finances=await financialSnapshot(f),{page}=await f.page('buyer-agent',{width,height:1000});
 await route(page,f.api.url,'new-print');const requests:string[]=[];page.on('request',r=>requests.push(r.url()+' '+(r.postData()??'')));
 await page.getByLabel('Inspect local STL for job metadata').setInputFiles({name:'PRIVATE-INTAKE.stl',mimeType:'application/octet-stream',buffer:Buffer.from(syntheticCube())});
 await page.getByText(/Local file · bytes and name not uploaded/).waitFor();await page.getByLabel('Model coordinate units').selectOption('mm');
 await page.getByLabel('Job quantity (each)').fill('2');await page.getByLabel('Job print budget (USD)').fill('60');
 await page.getByLabel('I reviewed the displayed metadata and terms for this synthetic work order.').check();
 const posted=ok(await submitted(page,'postWorkOrder',()=>page.getByRole('button',{name:'Post mock print job',exact:true}).click())),id=recordId(posted,'workOrderId');
 await page.waitForURL(`**/#work/${id}`);await settled(page);await page.getByRole('heading',{name:'Saved specification',exact:true}).waitFor();
 assert.equal(requests.some(r=>r.includes('PRIVATE-INTAKE')),false);assert.equal(JSON.stringify(await page.evaluate(()=>({...sessionStorage,...localStorage}))).includes('PRIVATE-INTAKE'),false);
 for(let i=0;i<150;i++)ok(await execute(f,'buyer')('postWorkOrder',workOrderInput(`ui-unrelated-${width}-${i}`,1,10000)));
 await switchTo(page,'producer-a');assert.equal(new URL(page.url()).hash,`#work/${id}`);
 await page.getByLabel('Response unit price (USD)',{exact:true}).fill('30');await page.getByLabel('Response origin',{exact:true}).fill('Fictional workshop');
 ok(await submitted(page,'respondToWorkOrder',()=>page.getByRole('button',{name:'Propose producer response',exact:true}).click()));assert.equal(new URL(page.url()).hash,`#work/${id}`);
 await page.getByRole('button',{name:/Review approval/}).click();await page.getByLabel('I approve these frozen terms for my business.',{exact:true}).check();
 ok(await submitted(page,'confirmMarketProposal',()=>page.getByRole('button',{name:'Confirm frozen terms',exact:true}).click()));
 await switchTo(page,'buyer');assert.equal(new URL(page.url()).hash,`#work/${id}`);
 await page.getByRole('button',{name:/Review approval/}).click();await page.getByLabel('I approve these frozen terms for my business.',{exact:true}).check();
 const confirmed=ok(await submitted(page,'confirmMarketProposal',()=>page.getByRole('button',{name:'Confirm frozen terms',exact:true}).click())),commitmentId=recordId(confirmed,'commitmentId');
 await page.getByRole('button',{name:/Review fulfillment/}).waitFor();await page.reload();await settled(page);await page.getByRole('button',{name:/Review fulfillment/}).waitFor();
 for(let part=0;part<2;part++){
  await switchTo(page,'producer-a');await page.getByRole('button',{name:/Review fulfillment/}).click();await page.getByLabel('Report quantity (each)',{exact:true}).fill('1');
  ok(await submitted(page,'reportMarketFulfillment',()=>page.getByRole('button',{name:'Report fulfillment',exact:true}).click()));
  await switchTo(page,'buyer');await page.getByRole('button',{name:/Review fulfillment/}).click();ok(await submitted(page,'acknowledgeMarketFulfillment',()=>page.getByRole('button',{name:'Acknowledge 1 each',exact:true}).click()));
 }
 await page.reload();await settled(page);await page.getByText(/Receipt complete/).waitFor();assert.equal((await getCommitment(execute(f,'buyer'),commitmentId)).state,'completed');assert.equal((await getOrder(execute(f,'buyer'),id)).budgetCommitted?.minorUnits,6000);
 assert.deepEqual(await financialSnapshot(f),finances);await snapshot(page,`persistent-print-job-${width}.png`);
 await route(page,f.api.url,'jobs');await snapshot(page,`persistent-print-list-${width}.png`);
 const action=page.locator('.auction-results').getByRole('button',{name:/^Select /}).first(),box=await action.boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=width,'Review action visible without horizontal scrolling');
});

test('persistent print draft invalidates review on changed terms and publishes nothing',{timeout:60000},async t=>{
 const f=await setup(t),{page}=await f.page('buyer'),before=await marketSnapshot(f);
 await route(page,f.api.url,'new-print');await page.getByRole('button',{name:'Use labeled synthetic cube'}).click();
 const reviewed=page.getByLabel('I reviewed the displayed metadata and terms for this synthetic work order.');await reviewed.check();await page.getByLabel('Job print budget (USD)').fill('31');assert.equal(await reviewed.isChecked(),false);
 await page.getByLabel('Print material profile').selectOption('resin');assert.equal(await page.getByRole('button',{name:'Post mock print job'}).isEnabled(),false);assert.deepEqual(await marketSnapshot(f),before);
});

test('print intake Zone B uses the displayed deadline; participant entry preserves the requested destination',{timeout:60000},async t=>{
 const f=await setup(t),context=await f.browser.newContext(),page=await context.newPage();t.after(()=>context.close());
 await page.goto(f.api.url+'/#new-print');await page.getByRole('button',{name:'Buyer human · review & publish',exact:false}).click();await settled(page);await page.getByRole('heading',{name:'Create a mock print job',exact:true}).waitFor();assert.equal(new URL(page.url()).hash,'#new-print');
 await page.getByRole('button',{name:'Use labeled synthetic cube'}).click();await page.getByLabel('Mock courier zone').selectOption('B');await page.getByLabel('Separate courier allowance (USD)').fill('18');
 const checkbox=page.getByLabel('I reviewed the displayed metadata and terms for this synthetic work order.');assert.equal(await checkbox.isEnabled(),false);
 const from=await page.getByLabel('Job available from (UTC)').inputValue();const future=new Date(Date.parse(from+'Z')+10*86400000).toISOString().slice(0,16);await page.getByLabel('Job delivery deadline (UTC)').fill(future);assert.equal(await checkbox.isEnabled(),true);await checkbox.check();assert.equal(await page.getByRole('button',{name:'Post mock print job',exact:true}).isEnabled(),true);
});

test('supply detail retains compatible input work beyond100 own records and mobile exposes key supply terms',{timeout:60000},async t=>{
 const f=await setup(t),buyer=execute(f,'buyer'),{page}=await f.page('buyer',{width:390,height:900});
 const inputId=recordId(ok(await buyer('postWorkOrder',workOrderInput('supply-compatible',2,5000,{itemId:'TIMBER-DEMO'}))),'workOrderId');
 for(let i=0;i<150;i++)ok(await buyer('postWorkOrder',workOrderInput('supply-unrelated-'+i,1,10000)));
 await route(page,f.api.url,'order/materialtimber-a');
 await page.getByLabel('Your input work order', {exact:true}).waitFor();assert.ok((await page.getByLabel('Your input work order',{exact:true}).locator('option').allTextContents()).some(v=>v.includes('2 each')));assert.match(await page.content(),/Propose an input purchase/);
 await route(page,f.api.url,'materials');await snapshot(page,'persistent-supply-mobile.png');assert.match(await page.locator('.auction-results').innerText(),/In stock|Made to order/);assert.equal((await getOrder(buyer,inputId)).allocatedQuantity.value,0);
});

test('job browser loads every scoped response across multiple pages',{timeout:60000},async t=>{
 const f=await setup(t),buyer=execute(f,'buyer'),producer=execute(f,'producer-a'),{page}=await f.page('buyer');
 const requirements={version:'mock-print.v1',profile:'FDM-PETG-175-BLACK-SYNTH',mesh:{format:'binary',triangles:12,bounds:[20,20,20],units:'mm',synthetic:true},materialResponsibility:'producer',delivery:{mode:'mock_courier',zone:'A',allowance:{minorUnits:1000,currency:'USD'}}};
 const id=recordId(ok(await buyer('postWorkOrder',{...workOrderInput('all-response-pages',10,30000),itemId:'PRINT-JOB-SYNTH',printRequirements:requirements,availableAt:new Date().toISOString(),deliveryBy:new Date(Date.now()+7*86400000).toISOString()})),'workOrderId');
 for(let i=0;i<105;i++)ok(await producer('respondToWorkOrder',responseInput('browser-many-response-'+i,id,1,3000)));
 await route(page,f.api.url,'work/'+id);assert.equal(await page.getByRole('button',{name:/Review approval/}).count(),105);
});

test('lost print-post reply recovers the same metadata/key and creates exactly one job item',{timeout:60000},async t=>{
 const f=await setup(t),{page}=await f.page('buyer');await route(page,f.api.url,'new-print');await page.getByRole('button',{name:'Use labeled synthetic cube'}).click();await page.getByLabel('I reviewed the displayed metadata and terms for this synthetic work order.').check();
 let captured!:()=>void;const committed=new Promise<void>(r=>{captured=r;});
 await page.route('**/commands/postWorkOrder',async r=>{await r.fetch();captured();await r.abort();});await page.getByRole('button',{name:'Post mock print job',exact:true}).click();await committed;
 await page.getByRole('button',{name:'Retry saved request',exact:true}).waitFor();await page.unroute('**/commands/postWorkOrder');await page.reload();await settled(page);
 ok(await submitted(page,'postWorkOrder',()=>page.getByRole('button',{name:'Retry saved request',exact:true}).click()));await page.getByRole('heading',{name:'Saved specification',exact:true}).waitFor();
 assert.equal((await f.pool.query("SELECT count(*) FROM market_items WHERE specification->>'kind'='mock-print-job'")).rows[0].count,'1');assert.equal((await f.pool.query("SELECT count(*) FROM market_orders o JOIN market_items i ON i.id=o.item_id WHERE i.specification->>'kind'='mock-print-job'")).rows[0].count,'1');
});
