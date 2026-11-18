import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Buffer} from 'node:buffer';
import {syntheticCube} from '../../apps/print-demo/model.ts';
import {setup,route,snapshot,switchTo} from './market-browser-helpers.ts';

for(const width of [1440,390])test('route demo '+width+': tradeoffs, scripted delay, keyboard review/reject/approve, freeze and separate reset',{timeout:60000},async t=>{
 const f=await setup(t),{page}=await f.page('buyer',{width,height:1080});await route(page,f.api.url,'route-demo');const before=await f.snapshot(),commands:string[]=[];
 page.on('request',req=>{if(req.url().includes('/commands/'))commands.push(req.url());});
 const review=page.getByRole('region',{name:'Human plan review'});
 assert.match(await page.getByRole('region',{name:'Mock route A'}).innerText(),/\$40\.00/);
 assert.match(await page.getByRole('region',{name:'Mock route B'}).innerText(),/\$46\.00/);
 assert.equal(await page.locator('.route-comparison').evaluate(el=>getComputedStyle(el).display),'grid');
 await snapshot(page,'routes-'+width+'-ready.png');
 await page.getByRole('button',{name:'Simulate A material delay',exact:true}).click();
 assert.match(await review.innerText(),/moving projected arrival to day 12/);await snapshot(page,'routes-'+width+'-delay.png');
 await review.getByRole('button',{name:'Reject recommendation',exact:true}).click();assert.equal(await review.getByRole('button',{name:'Approve simulated plan',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'Run scripted route check',exact:true}).click();const checkbox=review.getByRole('checkbox',{name:'I reviewed the synthetic route terms and tradeoffs.',exact:true});
 await checkbox.focus();await page.keyboard.press('Space');assert.equal(await checkbox.isChecked(),true);
 await review.getByRole('button',{name:'Approve recommended route B',exact:true}).focus();await page.keyboard.press('Enter');
 await review.getByRole('button',{name:'Freeze simulated agreement',exact:true}).focus();await page.keyboard.press('Enter');
 await review.getByText('SIM-RUN-1-AGREEMENT-B',{exact:true}).waitFor();await snapshot(page,'routes-'+width+'-frozen.png');
 await review.getByRole('button',{name:'Request route change — blocked',exact:true}).click();await review.getByText('SIM-RUN-1-AGREEMENT-B',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Start a new simulation',exact:true}).click();await page.getByText('RUN 2',{exact:true}).waitFor();
 await page.getByText('1 prior frozen simulation agreement',{exact:true}).click();assert.match(await page.getByText('SIM-RUN-1-AGREEMENT-B',{exact:false}).innerText(),/SIM-RUN-1-AGREEMENT-B/);
 assert.deepEqual(commands,[]);assert.deepEqual(await f.snapshot(),before,'Local planning sends no command and changes no shared financial/business record');
});

test('route demo: invalid alternatives and changed terms require renewed review',{timeout:60000},async t=>{
 const f=await setup(t),{page}=await f.page('buyer');await route(page,f.api.url,'route-demo');await page.getByText('Inspect a local STL or edit requirements',{exact:true}).click();
 await page.getByLabel('Output-work budget (USD)',{exact:true}).fill('30.00');await page.getByRole('button',{name:'Simulate A material delay',exact:true}).click();await page.getByRole('button',{name:'Run scripted route check',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Approve simulated plan',exact:true}).isDisabled(),true);assert.match(await page.getByRole('region',{name:'Mock route B'}).innerText(),/exceeds the stated output-work budget/);
 await page.getByLabel('Output-work budget (USD)',{exact:true}).fill('40.00');await page.getByRole('button',{name:'Run scripted route check',exact:true}).click();await page.getByRole('checkbox',{name:'I reviewed the synthetic route terms and tradeoffs.',exact:true}).check();await page.getByRole('button',{name:'Approve recommended route B',exact:true}).click();
 await page.getByRole('button',{name:'Freeze simulated agreement',exact:true}).waitFor();await page.getByLabel('Material color',{exact:true}).selectOption('white');
 assert.equal(await page.getByRole('button',{name:'Freeze simulated agreement',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Approve simulated plan',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'Reset simulation',exact:true}).click();await page.getByText('RUN 2',{exact:true}).waitFor();assert.equal(await page.getByLabel('Material color',{exact:true}).inputValue(),'black');
});

test('route demo: an existing frozen A agreement is never silently rerouted after material delay',{timeout:60000},async t=>{
 const f=await setup(t),{page}=await f.page('buyer',{width:390,height:844});await route(page,f.api.url,'route-demo');
 await page.getByRole('checkbox',{name:'I reviewed the synthetic route terms and tradeoffs.',exact:true}).check();await page.getByRole('button',{name:'Approve simulated plan',exact:true}).click();await page.getByRole('button',{name:'Freeze simulated agreement',exact:true}).click();
 await page.getByRole('button',{name:'Simulate A material delay',exact:true}).click();const review=page.getByRole('region',{name:'Human plan review'});await review.getByText('day 6 / day 12',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Approve recommended route B',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Select route B',exact:true}).isDisabled(),true);
 await review.getByRole('button',{name:'Request route change — blocked',exact:true}).click();await review.getByText('SIM-RUN-1-AGREEMENT-A',{exact:true}).waitFor();await snapshot(page,'routes-390-committed-delay.png');
});

test('route demo: file bytes/names stay local, coordinate units require confirmation and reload clears the simulation',{timeout:60000},async t=>{
 const f=await setup(t),{page}=await f.page('buyer');await route(page,f.api.url,'route-demo');const requests:string[]=[];page.on('request',r=>requests.push(r.url()+' '+(r.postData()??'')));
 await page.getByText('Inspect a local STL or edit requirements',{exact:true}).click();await page.getByLabel('Local STL (up to 10 MiB)',{exact:true}).setInputFiles({name:'private-route-design-marker.stl',mimeType:'application/octet-stream',buffer:Buffer.from(syntheticCube())});
 await page.getByRole('heading',{name:'Locally inspected STL metadata',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Approve simulated plan',exact:true}).isDisabled(),true);
 await page.getByLabel('STL coordinate units',{exact:true}).selectOption('mm');await page.getByRole('checkbox',{name:'I reviewed the synthetic route terms and tradeoffs.',exact:true}).check();await page.getByRole('button',{name:'Approve simulated plan',exact:true}).click();
 assert.equal((await page.locator('body').innerText()).includes('private-route-design-marker'),false);assert.equal(requests.some(r=>r.includes('private-route-design-marker')||r.includes('/commands/')),false);
 await page.reload();await page.getByRole('heading',{name:'Synthetic 20 mm cube · not your design',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Freeze simulated agreement',exact:true}).count(),0);
});

test('route demo: delegated participant can explore but cannot approve a recommendation',{timeout:60000},async t=>{
 const f=await setup(t),{page}=await f.page('buyer-agent');await route(page,f.api.url,'route-demo');await page.getByRole('button',{name:'Simulate A material delay',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Approve recommended route B',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Reject recommendation',exact:true}).isDisabled(),true);
 assert.match(await page.getByRole('region',{name:'Human plan review'}).innerText(),/lacks confirmation permission/);await switchTo(page,'buyer');await page.getByRole('checkbox',{name:'I reviewed the synthetic route terms and tradeoffs.',exact:true}).waitFor();
});
test('route demo mobile: relaxed deadline retains feasible A and long invalid values do not overflow',{timeout:60000},async t=>{
 const f=await setup(t),{page}=await f.page('buyer',{width:390,height:844});await route(page,f.api.url,'route-demo');await page.getByText('Inspect a local STL or edit requirements',{exact:true}).click();
 await page.getByLabel('Arrival deadline (simulation day)',{exact:true}).fill('30');await page.getByRole('button',{name:'Simulate A material delay',exact:true}).click();await page.getByRole('button',{name:'Run scripted route check',exact:true}).click();
 const review=page.getByRole('region',{name:'Human plan review'});assert.match(await review.innerText(),/still fits/);assert.doesNotMatch(await review.innerText(),/beyond your/);assert.equal(await page.getByRole('button',{name:'Approve recommended route B',exact:true}).count(),0);
 await page.getByRole('checkbox',{name:'I reviewed the synthetic route terms and tradeoffs.',exact:true}).check();await page.getByRole('button',{name:'Approve simulated plan',exact:true}).click();await page.getByRole('button',{name:'Freeze simulated agreement',exact:true}).click();await review.getByText('day 12 / day 12',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Start a new simulation',exact:true}).click();
 for(const label of ['Counted parts','Output-work budget (USD)','Separate courier allowance (USD)','Arrival deadline (simulation day)']){
  const input=page.getByLabel(label,{exact:true});await input.fill('9'.repeat(80));assert.ok((await input.inputValue()).length<=12);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true,label);
 }
 assert.equal(await page.getByRole('button',{name:'Approve simulated plan',exact:true}).isDisabled(),true);
});
