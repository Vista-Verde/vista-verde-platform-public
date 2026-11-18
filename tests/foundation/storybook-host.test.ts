import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdirSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type { AxeResults } from 'axe-core';
import { startHttp } from '../../apps/api/src/http.ts';
import { fixture } from './helpers.ts';

const artifacts=resolve(process.env.VV_STORYBOOK_ARTIFACTS ?? 'storybook-artifacts');
const axeSource=readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'),'utf8');
async function setup(t:Parameters<typeof fixture>[0]) {
  const f=await fixture(t);
  const personas={ buyer:{ label:'Synthetic buyer',token:f.token('buyer') } };
  const api=await startHttp(f.connectionString,'local_test',{ personas,storybook:true });
  f.cleanupWith(() => api.close());return { ...f,api };
}

test('production routing keeps the app/API namespace and canonicalizes known Storybook links without data changes',async t=>{
 const f=await setup(t),before=await f.snapshot();
 const root=await fetch(f.api.url),rootBytes=await root.text();assert.match(rootBytes,/id="root"/);assert.match(root.headers.get('content-security-policy')!,/frame-ancestors 'none'/);
 for(const path of ['/app','/app/'])assert.equal(await(await fetch(f.api.url+path)).text(),rootBytes);
 for(const [path,target] of [['/storybook','/storybook/'],['/?path=/story/print-coordinated-route-demo--recommendation-pending','/storybook/?path=/story/print-coordinated-route-demo--recommendation-pending'],['/iframe.html?id=print-coordinated-route-demo--recommendation-pending','/storybook/iframe.html?id=print-coordinated-route-demo--recommendation-pending'],['/index.json','/storybook/index.json']]){
  for(const method of ['GET','HEAD']){const r=await fetch(f.api.url+path,{method,redirect:'manual'});assert.equal(r.status,308);assert.equal(r.headers.get('location'),target);assert.equal(r.headers.get('set-cookie'),null);assert.equal(await r.text(),'');}
 }
 const head=await fetch(f.api.url+'/storybook/index.json',{method:'HEAD'});assert.equal(head.status,200);assert.ok(Number(head.headers.get('content-length'))>0);assert.equal(await head.text(),'');
 for(const path of ['/storybook/commands/postWorkOrder','/storybook/queries/getMarketWorkspace','/storybook/session','/storybook/unknown.js','/?path=https://hostile.invalid','/?persona=buyer'])assert.equal((await fetch(f.api.url+path,{redirect:'manual'})).status,403,path);
 assert.deepEqual(await f.snapshot(),before,'Static routing and redirects create no domain or financial changes');
});

test('Production coordinated-route preview supports explicit decisions under existing CSP without shared commands',async t=>{
 const {api}=await setup(t),browser=await chromium.launch();t.after(()=>browser.close());mkdirSync(artifacts,{recursive:true});
 for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:1080}}),page=await context.newPage();const errors:string[]=[],operations:string[]=[],external:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  page.on('request',request=>{const url=new URL(request.url());if(/^\/(session|commands|queries)(\/|$)/.test(url.pathname))operations.push(url.pathname);if(url.origin!==api.url)external.push(url.origin);});
  const response=await page.goto(api.url+'/storybook/iframe.html?id=print-coordinated-route-demo--recommendation-pending&viewMode=story');assert.equal(response?.status(),200);
  const review=page.getByRole('region',{name:'Human plan review'});await review.getByRole('button',{name:'Approve recommended route B',exact:true}).waitFor();
  assert.equal(await review.getByRole('button',{name:'Approve recommended route B',exact:true}).isDisabled(),true);
  await review.getByRole('checkbox',{name:'I reviewed the synthetic route terms and tradeoffs.',exact:true}).check();await review.getByRole('button',{name:'Approve recommended route B',exact:true}).click();
  await review.getByRole('button',{name:'Freeze simulated agreement',exact:true}).click();await review.getByRole('button',{name:'Request route change — blocked',exact:true}).click();await review.getByText('SIM-RUN-1-AGREEMENT-B',{exact:true}).waitFor();
  await page.evaluate(axeSource);const violations=await page.evaluate(async()=>(await(window as unknown as{axe:{run:(root:Document,options:unknown)=>Promise<AxeResults>}}).axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}})).violations.map(v=>v.id));
  assert.deepEqual(violations,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
  await page.screenshot({path:resolve(artifacts,`routes-static-${width}.png`),fullPage:true});assert.deepEqual(errors,[]);assert.deepEqual(operations,[]);assert.deepEqual(external,[]);await context.close();
 }
});

test('Production print planner stays local under existing CSP; mock approvals and simulated receipt are accessible on desktop/mobile',async t=>{
  const {api}=await setup(t),browser=await chromium.launch();t.after(()=>browser.close());mkdirSync(artifacts,{recursive:true});
  for(const width of [1440,390]){
    const context=await browser.newContext({viewport:{width,height:1080}}),page=await context.newPage();const errors:string[]=[],operations:string[]=[],external:string[]=[];
    page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    page.on('request',request=>{const url=new URL(request.url());if(/^\/(session|commands|queries)(\/|$)/.test(url.pathname))operations.push(url.pathname);if(url.origin!==api.url)external.push(url.origin);});
    const response=await page.goto(api.url+'/storybook/iframe.html?id=print-mock-3d-print-journey--upload-required&viewMode=story');assert.equal(response?.status(),200);
    await page.getByText(/Upload required · no user design/).waitFor();assert.equal(await page.getByRole('button',{name:'Approve mock print terms'}).isEnabled(),false);
    await page.getByRole('button',{name:'Load synthetic 20 mm cube'}).click();await page.getByText(/Bundled synthetic test fixture · not your design/).waitFor();
    for(const name of ['Approve mock print terms','Approve mock delivery plan','Simulate printing','Simulate courier dispatch','Simulate delivered event'])await page.getByRole('button',{name,exact:true}).click();
    assert.equal(await page.getByText('Simulated receipt acknowledged. No real goods moved.').count(),0);
    await page.getByRole('button',{name:'Acknowledge simulated receipt'}).click();
    await page.evaluate(axeSource);const violations=await page.evaluate(async()=>(await(window as unknown as{axe:{run:(root:Document,options:unknown)=>Promise<AxeResults>}}).axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}})).violations.map(v=>v.id));
    assert.deepEqual(violations,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
    await page.screenshot({path:resolve(artifacts,`print-preview-${width}.png`),fullPage:true});assert.deepEqual(errors,[]);assert.deepEqual(operations,[]);assert.deepEqual(external,[]);await context.close();
  }
});

test('Production agent architecture is readable, accessible and nonbinding under existing static CSP on desktop and mobile',async t=>{
  const{api}=await setup(t);const browser=await chromium.launch();t.after(()=>browser.close());mkdirSync(artifacts,{recursive:true});
  const commands:string[]=[];
  for(const width of[1440,390]){
    const context=await browser.newContext({viewport:{width,height:1080}});const page=await context.newPage(),errors:string[]=[];
    page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    page.on('request',request=>{if(/^\/(session|commands|queries)(\/|$)/.test(new URL(request.url()).pathname))commands.push(new URL(request.url()).pathname);});
    const response=await page.goto(api.url+'/storybook/iframe.html?id=architecture-agents-operate-humans-supervise--overview&viewMode=story');assert.equal(response?.status(),200);
    await page.getByRole('heading',{name:/Agents operate.*Humans supervise/}).waitFor();
    assert.equal(await page.getByRole('img',{name:/Agents operate, humans supervise/}).count(),1,'Only the appropriate readable SVG layout is exposed');
    const svg=page.getByRole('img',{name:/Agents operate, humans supervise/});assert.ok((await svg.boundingBox())!.width>300);
    await page.getByRole('region',{name:'Architecture text equivalent'}).waitFor();await page.getByText(/does not implement a universal human-approval policy/).waitFor();
    await page.evaluate(axeSource);const violations=await page.evaluate(async()=>(await(window as unknown as{axe:{run:(root:Document,options:unknown)=>Promise<AxeResults>}}).axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}})).violations.map(v=>v.id));
    assert.deepEqual(violations,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
    await page.screenshot({path:resolve(artifacts,`agent-architecture-${width}.png`),fullPage:true});assert.deepEqual(errors,[]);await context.close();
  }
  assert.deepEqual(commands,[],'The architecture makes no session, query or command request');
});

test('Production Storybook root uses hashed inline scripts; working app and API keep their own policy',async t => {
  const { api }=await setup(t);
  const app=await fetch(api.url);assert.equal(app.status,200);assert.match(await app.text(),/id="root"/);assert.match(app.headers.get('content-security-policy')!,/frame-ancestors 'none'/);
  const root=await fetch(api.url+'/storybook/');assert.equal(root.status,200);
  assert.match(await root.text(),/storybook/i);
  const policy=root.headers.get('content-security-policy')!;
  assert.match(policy,/script-src 'self' 'sha256-/);
  assert.doesNotMatch(policy,/unsafe-eval|script-src[^;]*unsafe-inline/);
  assert.match(policy,/frame-src 'self'/);assert.match(policy,/frame-ancestors 'self'/);
  for (const path of ['/app','/legacy','/session']) {
    const response=await fetch(api.url+path);assert.equal(response.status,200);
    assert.match(response.headers.get('content-security-policy')!,/frame-ancestors 'none'/);
    assert.doesNotMatch(response.headers.get('content-security-policy')!,/unsafe-inline|unsafe-eval/);
  }
  for (const path of ['/packages/contracts/src/market.ts','/../package.json','/%2e%2e/package.json','/index.html.map','/.env']) {
    const response=await fetch(api.url+path);assert.equal(response.status,403,path);
  }
  const cross=await fetch(api.url+'/storybook/iframe.html',{ headers:{ 'sec-fetch-site':'cross-site' } });assert.equal(cross.status,403);
  const origin=await fetch(api.url+'/storybook/',{ headers:{ origin:'https://outside.invalid' } });assert.equal(origin.status,403);
});

test('Production Storybook manager and synthetic preview render under static CSP at desktop and mobile sizes',async t => {
  const { api }=await setup(t);const browser=await chromium.launch();t.after(() => browser.close());
  mkdirSync(artifacts,{ recursive:true });
  const index=await (await fetch(api.url+'/storybook/index.json')).json() as { entries:Record<string,{ id:string;title:string;type:string }> };
  const entries=Object.values(index.entries).filter(entry => entry.type==='story');
  const table=entries.find(entry => entry.title==='Market/Order table' && entry.id.endsWith('--representative'));
  assert.ok(table,'Representative actual component is included in the production artifact');
  for (const viewport of [{ width:1440,height:1080 },{ width:390,height:844 }]) {
    const context=await browser.newContext({ viewport });const page=await context.newPage();
    const errors:string[]=[];page.on('pageerror',error => errors.push(error.message));
    page.on('console',message => { if (message.type()==='error') errors.push(message.text()); });
    await page.goto(`${api.url}/storybook/?path=/story/${table.id}`);
    const frame=page.frameLocator('#storybook-preview-iframe');
    await frame.getByText('Synthetic component fixture · interactions are local and non-persistent.',{ exact:false }).waitFor();
    await frame.getByRole('table').waitFor();
    assert.deepEqual(errors,[],'Static manager and preview execute without runtime or CSP failures');
    await page.screenshot({ path:resolve(artifacts,`storybook-manager-${viewport.width}.png`),fullPage:true });
    await page.goto(`${api.url}/storybook/iframe.html?id=${table.id}&viewMode=story`);
    await page.getByRole('table').waitFor();await page.evaluate(axeSource);
    const results=await page.evaluate(async () => await (window as unknown as { axe:{ run:(root:Document,options:unknown)=>Promise<AxeResults> } }).axe.run(document,{ runOnly:{ type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'] } }));
    assert.deepEqual(results.violations.map(v => ({ id:v.id,targets:v.nodes.map(n => n.target) })),[]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
    await page.screenshot({ path:resolve(artifacts,`storybook-preview-${viewport.width}.png`),fullPage:true });
    await context.close();
  }
});

test('Production static work-board and exploratory economics previews remain usable and synthetic on phones',async t => {
  const { api }=await setup(t);const browser=await chromium.launch();t.after(() => browser.close());
  mkdirSync(artifacts,{ recursive:true });
  const index=await (await fetch(api.url+'/storybook/index.json')).json() as { entries:Record<string,{ id:string;title:string;type:string }> };
  const entries=Object.values(index.entries).filter(entry => entry.type==='story');
  assert.equal(entries[0]?.id,'platform-audience-pitches--overview');
  assert.ok(entries.some(entry=>entry.id==='print-persistent-job-workspace--requirements'),'Persistent print workspace remains included after the audience introduction');
  const board=entries.find(entry=>entry.id==='work-orders-work-order-board--representative');assert.ok(board,'General work-board fallback remains included');
  const economics=entries.find(entry => entry.title==='Economics/Exploratory model' && entry.id.endsWith('--base'));
  assert.ok(economics,'Exploratory economics is included alongside the work board');
  for (const width of [1440,390]) {
    const context=await browser.newContext({ viewport:{ width,height:1080 } });const page=await context.newPage();
    const errors:string[]=[];page.on('pageerror',error => errors.push(error.message));
    page.on('console',message => { if(message.type()==='error') errors.push(message.text()); });
    for (const [id,label,heading] of [[board.id,'work-board','Work orders'],[economics.id,'economics','What would the work order board earn?']]) {
      await page.goto(`${api.url}/storybook/iframe.html?id=${id}&viewMode=story`);
      await page.getByRole('heading',{ name:heading,exact:true }).waitFor();
      await page.evaluate(axeSource);
      const results=await page.evaluate(async () => await (window as unknown as { axe:{ run:(root:Document,options:unknown)=>Promise<AxeResults> } }).axe.run(document,{ runOnly:{ type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'] } }));
      assert.deepEqual(results.violations.map(v => v.id),[]);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
      await page.screenshot({ path:resolve(artifacts,`storybook-${label}-${width}.png`),fullPage:true });
    }
    assert.deepEqual(errors,[],'Work and economics previews have no runtime or CSP errors');
    await context.close();
  }
});

test('Production audience pitches retain their shared flow, proof boundary and mounted navigation under static CSP',async t => {
  const { api }=await setup(t);const browser=await chromium.launch();t.after(() => browser.close());
  const index=await (await fetch(api.url+'/storybook/index.json')).json() as { entries:Record<string,{ id:string;title:string;type:string }> };
  const audiences=Object.values(index.entries).filter(entry=>entry.type==='story' && entry.title==='Platform/Audience pitches');
  assert.equal(audiences.length,5);
  for(const width of [1440,390]) {
    const context=await browser.newContext({ viewport:{ width,height:1080 } });const page=await context.newPage();
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{ if(message.type()==='error') errors.push(message.text()); });
    for(const entry of audiences) {
      await page.goto(`${api.url}/storybook/iframe.html?id=${entry.id}&viewMode=story`);
      await page.locator('[data-audience-play-complete]').waitFor();
      await page.getByRole('heading',{ level:1 }).waitFor();
      assert.equal(await page.getByRole('navigation',{ name:'Audience pages' }).getByRole('link').count(),5);
      assert.equal(await page.locator('nav [aria-current="page"]').count(),1);
      await page.getByText('Agents coordinate. People approve commitments.').waitFor();
      await page.getByText('Commercial demand, physical production, payments and authenticated remote MCP.',{ exact:false }).waitFor();
      await page.evaluate(axeSource);
      const results=await page.evaluate(async () => await (window as unknown as { axe:{ run:(root:Document,options:unknown)=>Promise<AxeResults> } }).axe.run(document,{ runOnly:{ type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'] } }));
      assert.deepEqual(results.violations.map(v=>v.id),[]);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
    }
    await page.goto(`${api.url}/storybook/`);
    await page.waitForURL(url=>url.searchParams.get('path')==='/story/platform-audience-pitches--overview');
    const frame=page.frameLocator('#storybook-preview-iframe');
    await frame.locator('[data-audience-play-complete]').waitFor();
    await frame.getByRole('link',{ name:'Buyers',exact:true }).click();
    await page.waitForURL(url=>url.pathname==='/storybook/' && url.searchParams.get('path')==='/story/platform-audience-pitches--buyers');
    await page.frameLocator('#storybook-preview-iframe').getByRole('heading',{ level:1,name:'Buyers',exact:true }).waitFor();
    assert.deepEqual(errors,[],'Audience pages and mounted navigation execute without runtime or CSP failures');
    await context.close();
  }
});

test('Production Research previews distinguish evidence and remain read-only under static CSP on desktop and phones',async t => {
  const { api }=await setup(t);const browser=await chromium.launch();t.after(() => browser.close());
  mkdirSync(artifacts,{ recursive:true });
  const index=await (await fetch(api.url+'/storybook/index.json')).json() as { entries:Record<string,{ id:string;title:string;type:string }> };
  const research=Object.values(index.entries).filter(entry => entry.type==='story' && entry.title.startsWith('Research/'));
  assert.equal(research.length,2,'Bounded read-only synthesis adds exactly two research views');
  for(const width of [1440,390]) {
    const context=await browser.newContext({ viewport:{ width,height:1080 } });const page=await context.newPage();
    const errors:string[]=[];const commands:string[]=[];
    page.on('pageerror',error => errors.push(error.message));
    page.on('console',message => { if(message.type()==='error') errors.push(message.text()); });
    page.on('request',request => { if(/^\/(api|session|mcp)(\/|$)/.test(new URL(request.url()).pathname)) commands.push(request.url()); });
    for(const entry of research) {
      await page.goto(`${api.url}/storybook/iframe.html?id=${entry.id}&viewMode=story`);
      await page.getByRole('heading',{ level:1 }).waitFor();
      await page.getByText('No verified demand, GMV, LOIs or marketplace liquidity is established by this demo.',{ exact:false }).waitFor();
      await page.evaluate(axeSource);
      const results=await page.evaluate(async () => await (window as unknown as { axe:{ run:(root:Document,options:unknown)=>Promise<AxeResults> } }).axe.run(document,{ runOnly:{ type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'] } }));
      assert.deepEqual(results.violations.map(v => v.id),[]);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
      assert.equal(await page.getByRole('button').count(),0,'Research cannot submit a market command, application or registration');
      if(entry.title==='Research/Demo opportunities') assert.ok(await page.getByRole('link').count()>=7,'Primary source citations travel with the preview');
      await page.screenshot({ path:resolve(artifacts,`${entry.id}-${width}.png`),fullPage:true });
    }
    assert.deepEqual(commands,[]);assert.deepEqual(errors,[]);
    await context.close();
  }
});
