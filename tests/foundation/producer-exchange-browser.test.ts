import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {readFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import type {Page} from 'playwright';
import {startProducer} from '../../apps/producer-demo/server.ts';
import {ProducerClient} from '../../apps/producer-demo/requester.ts';
import {startProducerPreview} from '../../apps/producer-demo/preview.ts';
import {fixture} from './helpers.ts';
import {web} from './web-helpers.ts';
import {financialSnapshot,marketSnapshot} from './market-helpers.ts';
import {PRODUCER_VERSION} from '../../apps/producer-demo/protocol.ts';
import {ProducerStore} from '../../apps/producer-demo/store.ts';

async function send(page:Page){await page.getByRole('button',{name:'Send brief to producer',exact:true}).click();await page.getByRole('heading',{name:'Conditional producer quote',exact:true}).waitFor();}
test('durable requester UI: lost acceptance reply and producer restart recover saved intent and the same job',{timeout:45000},async t=>{
  const directory=mkdtempSync(join(tmpdir(),'vv-producer-browser-recovery-')),stateFile=join(directory,'state.sqlite');
  let producer=await startProducer({stateFile,progressMs:[3000,6500]});const endpoint=producer.url,client=new ProducerClient(endpoint),preview=await startProducerPreview(client),browser=await chromium.launch();
  t.after(async()=>{await browser.close();await preview.close();await producer.close();rmSync(directory,{recursive:true,force:true});});
  const page=await browser.newPage({viewport:{width:390,height:844}});await page.goto(preview.url);await send(page);
  await page.route('**/producer-demo/accept',async route=>{await route.fetch();await route.abort('failed');});
  await page.getByRole('button',{name:/Approve \$25.00/}).click();await page.getByRole('button',{name:'Retry saved command',exact:true}).waitFor();
  const list=await client.call('independent-preview','read',{schemaVersion:PRODUCER_VERSION}),id=list.recent[0]!.requestId;
  await producer.close();const stored=new ProducerStore(stateFile),accepted=stored.get('independent-preview',id)!.exchange;stored.close();
  assert.ok(accepted.job?.state==='queued'||accepted.job?.state==='printing');await delay(6600);
  producer=await startProducer({stateFile,port:Number(new URL(endpoint).port)});
  const recovered=(await client.call('independent-preview','read',{schemaVersion:PRODUCER_VERSION,requestId:id})).exchange!;assert.deepEqual(recovered,accepted,'No offline progress is inferred');
  await page.unroute('**/producer-demo/accept');await page.reload();
  await page.getByRole('button',{name:'Retry saved command',exact:true}).click();
  await page.getByRole('heading',{name:'Completed · simulated',exact:true}).waitFor();
  const final=(await client.call('independent-preview','read',{schemaVersion:PRODUCER_VERSION,requestId:id})).exchange!;
  assert.equal(final.job!.jobId,accepted.job!.jobId);assert.equal(final.messages.filter(m=>m.kind==='ProducerAccepted').length,1);assert.equal(final.messages.length,7);
  assert.equal(await page.getByRole('button',{name:'Retry saved command',exact:true}).count(),0);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth));
});
for(const width of [1440,390])test(`independent requester UI ${width}px: HTTP quote changes, approval, received status, reload, no invented offline updates`,{timeout:60000},async t=>{
  const producer=await startProducer({unitPriceMinor:2300,progressMs:[500,1200]}),preview=await startProducerPreview(new ProducerClient(producer.url)),browser=await chromium.launch();
  t.after(async()=>{await browser.close();await preview.close();await producer.close();});
  const page=await browser.newPage({viewport:{width,height:1000}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(preview.url);
  const initial=await page.evaluate(()=>localStorage.getItem('vv.producer-demo.v1.independent-preview'));assert.equal(initial,null);
  await send(page);assert.match(await page.getByRole('region',{name:'Producer exchange'}).innerText(),/\$28\.00/);
  const approve=page.getByRole('button',{name:/Approve \$28.00/});await approve.focus();await page.keyboard.press('Enter');
  await page.getByRole('heading',{name:'Completed · simulated',exact:true}).waitFor();assert.match(await page.getByRole('region',{name:'Producer exchange'}).innerText(),/update 3/);
  await page.evaluate(readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'),'utf8'));
  const violations=await page.evaluate(async()=>{
    const axe=(window as unknown as{axe:{run:(root:Document,options:unknown)=>Promise<{violations:{id:string;nodes:{target:string[];failureSummary?:string}[]}[]}>}}).axe;
    return(await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}})).violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,detail:n.failureSummary}))}));
  });assert.deepEqual(violations,[],'Exchange UI automated accessibility');
  const artifacts=resolve(process.env.VV_WEB_ARTIFACTS??'web-artifacts');mkdirSync(artifacts,{recursive:true});await page.screenshot({path:resolve(artifacts,`producer-exchange-${width}.png`),fullPage:true});
  await page.getByText('Technical details',{exact:true}).click();const before=await page.getByRole('region',{name:'Producer exchange'}).innerText();const job=before.match(/Job ([a-f0-9-]{36})/)![1];
  await page.reload();await page.getByText(/Recent requests/).click();await page.getByRole('button',{name:/Desk organizer bracket|A small bracket/}).click();await page.getByRole('heading',{name:'Completed · simulated'}).waitFor();await page.getByText('Technical details',{exact:true}).click();assert.match(await page.getByRole('region',{name:'Producer exchange'}).innerText(),new RegExp(job!));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth));
  await producer.close();await page.getByText('New request',{exact:true}).click();await page.getByRole('button',{name:'Send brief to producer',exact:true}).click();await page.getByRole('button',{name:'Retry saved command',exact:true}).waitFor();await page.getByRole('alert').filter({hasText:'UNAVAILABLE'}).waitFor();
  assert.match(await page.getByRole('region',{name:'Producer exchange'}).innerText(),new RegExp(job!));assert.ok(await page.evaluate(()=>Boolean(localStorage.getItem('vv.producer-demo.v1.independent-preview'))));assert.deepEqual(errors,[]);
});
test('authenticated app: buyer-agent sends, human sees same organization quote, approval failure is producer-originated; financial and market stores unchanged',{timeout:60000},async t=>{
  const f=await fixture(t),producer=await startProducer({progressMs:[100,250]});f.cleanupWith(()=>producer.close());const api=await web(f,{legacy:false,producer:new ProducerClient(producer.url)}),browser=await chromium.launch();f.cleanupWith(()=>browser.close());
  const financial=await financialSnapshot(f),market=await marketSnapshot(f),page=await browser.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(api.url);
  await page.getByRole('button',{name:'Buyer agent · draft demand',exact:false}).click();await page.getByRole('link',{name:'Request a quote',exact:true}).click();
  await page.getByLabel('Simulated outcome',{exact:true}).selectOption('fail_after_start');await send(page);assert.equal(await page.getByRole('button',{name:/Approve \$25.00/}).isDisabled(),true);
  await page.getByLabel('Demo participant',{exact:true}).selectOption('buyer');await page.getByText(/Recent requests/).click();await page.getByRole('button',{name:/A small bracket/}).click();
  await page.getByRole('button',{name:/Approve \$25.00/}).click();await page.getByRole('heading',{name:'Failed · simulated',exact:true}).waitFor();
  assert.deepEqual(await financialSnapshot(f),financial);assert.deepEqual(await marketSnapshot(f),market);
  assert.deepEqual(errors,[]);
});
