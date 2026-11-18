import assert from 'node:assert/strict';
import {test} from 'node:test';
import {syntheticCube} from '../../apps/print-demo/model.ts';
import {setup,route,snapshot} from './market-browser-helpers.ts';
import {financialSnapshot,marketSnapshot} from './market-helpers.ts';

test('print app: local STL privacy, explicit units, incompatible profiles, approval invalidation and keyboard receipt; desktop and mobile accessible', {timeout:120000},async t=>{
  const f=await setup(t),before=await marketSnapshot(f),finances=await financialSnapshot(f);
  for(const width of [1440,390]){
    const {page,context}=await f.page('buyer',{width,height:1080});await route(page,f.api.url,'print-demo');
    const requests:string[]=[],commands:string[]=[];
    page.on('request',request=>{requests.push(request.url()+' '+(request.postData() ?? ''));if(request.url().includes('/commands/'))commands.push(request.url());});
    const storage=await page.evaluate(()=>({local:{...localStorage},session:{...sessionStorage}}));
    await page.getByText(/Upload required · no user design/).waitFor();assert.equal(await page.getByRole('button',{name:'Approve mock print terms'}).isEnabled(),false);
    await page.getByLabel('Inspect a local STL (up to 10 MiB)').setInputFiles({name:'PRIVATE-USER-DESIGN.stl',mimeType:'application/octet-stream',buffer:Buffer.from(syntheticCube())});
    await page.getByText(/Local user file · no upload/).waitFor();assert.equal(await page.getByLabel('STL coordinate units').inputValue(),'');
    assert.equal((await page.locator('.print-demo').innerText()).includes('PRIVATE-USER-DESIGN'),false);
    await page.getByLabel('STL coordinate units').selectOption('mm');
    await page.getByRole('button',{name:'Approve mock print terms'}).focus();await page.keyboard.press('Enter');await page.getByRole('button',{name:'Approve mock delivery plan'}).waitFor();
    await page.getByLabel('Process and material').selectOption('resin');assert.equal(await page.getByRole('button',{name:'Approve mock print terms'}).isEnabled(),false);
    assert.equal(await page.getByRole('button',{name:'Approve mock delivery plan'}).count(),0);
    await page.getByRole('button',{name:'Load synthetic 20 mm cube'}).click();
    for(const name of ['Approve mock print terms','Approve mock delivery plan','Simulate printing','Simulate courier dispatch','Simulate delivered event'])await page.getByRole('button',{name,exact:true}).click();
    assert.equal(await page.getByText('Simulated receipt acknowledged. No real goods moved.').count(),0);
    await page.getByRole('button',{name:'Acknowledge simulated receipt'}).click();await page.getByText('Simulated receipt acknowledged. No real goods moved.').waitFor();
    assert.equal(await page.getByText('$40.00',{exact:true}).count(),1);
    await snapshot(page,`print-demo-${width}.png`);
    assert.deepEqual(await page.evaluate(()=>({local:{...localStorage},session:{...sessionStorage}})),storage);
    assert.deepEqual(commands,[]);assert.equal(requests.some(value=>value.includes('PRIVATE-USER-DESIGN')),false);
    assert.equal(requests.some(value=>!value.startsWith(f.api.url)),false,'Planner has no external requests');
    await route(page,f.api.url,'work-orders');await route(page,f.api.url,'print-demo');await page.getByText(/Upload required · no user design/).waitFor();
    await context.close();
  }
  assert.deepEqual(await marketSnapshot(f),before);assert.deepEqual(await financialSnapshot(f),finances);
});
test('print app: malformed STL clears earlier approval and customer material acceptance resets on changed terms', {timeout:60000},async t=>{
  const f=await setup(t),{page}=await f.page('buyer');await route(page,f.api.url,'print-demo');
  await page.getByRole('button',{name:'Load synthetic 20 mm cube'}).click();await page.getByRole('button',{name:'Approve mock print terms'}).click();
  await page.getByLabel('Inspect a local STL (up to 10 MiB)').setInputFiles({name:'invalid.stl',mimeType:'application/octet-stream',buffer:Buffer.from('invalid mesh')});
  await page.getByRole('alert').filter({hasText:'ASCII STL needs complete'}).waitFor();assert.equal(await page.getByRole('button',{name:'Approve mock print terms'}).isEnabled(),false);
  await page.getByRole('button',{name:'Load synthetic 20 mm cube'}).click();await page.getByLabel('Material responsibility').selectOption('customer');
  const accepted=page.getByRole('checkbox',{name:/Mock producer explicitly accepts/});await accepted.check();assert.equal(await page.getByRole('button',{name:'Approve mock print terms'}).isEnabled(),true);
  await page.getByLabel('Mock delivery zone').selectOption('B');assert.equal(await accepted.isChecked(),false);assert.equal(await page.getByRole('button',{name:'Approve mock print terms'}).isEnabled(),false);
});

test('print app: a delayed file read cannot overwrite a newer synthetic fixture or revive its approval', {timeout:60000},async t=>{
  const f=await setup(t),{page}=await f.page('buyer');await route(page,f.api.url,'print-demo');
  await page.evaluate(()=>{
    const original=File.prototype.arrayBuffer;
    File.prototype.arrayBuffer=function(){
      if(this.name!=='DELAYED-TEST.stl')return original.call(this);
      return new Promise<ArrayBuffer>(resolve=>{(window as unknown as {finishDelayed:()=>Promise<void>}).finishDelayed=async()=>resolve(await original.call(this));});
    };
  });
  await page.getByLabel('Inspect a local STL (up to 10 MiB)').setInputFiles({name:'DELAYED-TEST.stl',mimeType:'application/octet-stream',buffer:Buffer.from(syntheticCube())});
  await page.getByText('Inspecting local STL…',{exact:true}).waitFor();await page.getByRole('button',{name:'Load synthetic 20 mm cube'}).click();
  await page.getByRole('button',{name:'Approve mock print terms'}).click();
  await page.evaluate(async()=>{await(window as unknown as{finishDelayed:()=>Promise<void>}).finishDelayed();await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));});
  assert.equal(await page.getByText(/Bundled synthetic test fixture · not your design/).count(),1);
  assert.equal(await page.getByText(/Local user file · no upload/).count(),0);assert.equal(await page.getByLabel('STL coordinate units').inputValue(),'mm');
  assert.equal(await page.getByRole('button',{name:'Approve mock delivery plan'}).count(),1);
});
