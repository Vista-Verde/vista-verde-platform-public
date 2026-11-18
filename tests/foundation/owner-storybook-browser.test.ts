import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import type { AxeResults } from 'axe-core';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { productionStorybook, storybookArtifactDigest } from '../../apps/api/src/storybook.ts';
import { OWNER_HOST, OWNER_EMAIL, OWNER_ORIGIN, OWNER_ISSUER, OWNER_COOKIE,
  startOwnerAccess } from '../../apps/local/src/owner-access.ts';
import { fixture } from './helpers.ts';
import { web } from './web-helpers.ts';

test('real Chromium owner redirect renders work, economics and read-only Research under CSP while preserving /app and denying foreign access',async t => {
  const f=await fixture(t),api=await web(f),before=await f.snapshot();
  const assets=productionStorybook(),artifactDigest=storybookArtifactDigest(assets);
  const index=JSON.parse(assets.get('/index.json')!.body.toString()) as { entries:Record<string,{ type:string;title:string }> };
  assert.equal(Object.values(index.entries).filter(entry => entry.type==='story' && entry.title.startsWith('Research/')).length,2,'Exactly two read-only Research stories are included');
  const pair=await generateKeyPair('RS256'),audience='a'.repeat(64);
  const keys=createLocalJWKSet({ keys:[{ ...await exportJWK(pair.publicKey),kid:'owner-storybook-browser-fixture',alg:'RS256' }] });
  const now=Math.floor(Date.now()/1000);
  let assertion=await new SignJWT({ iss:OWNER_ISSUER,aud:[audience],iat:now,exp:now+3600,
    sub:'owner-storybook-browser-fixture',email:OWNER_EMAIL,type:'app' })
    .setProtectedHeader({ alg:'RS256',kid:'owner-storybook-browser-fixture' }).sign(pair.privateKey);
  const gateway=await startOwnerAccess(api.url,{ audience },{ keys,port:0,host:'127.0.0.1',storybook:{ artifactDigest } });
  f.cleanupWith(() => gateway.close());
  const directory=mkdtempSync(join(tmpdir(),'vv-owner-storybook-browser-'));
  f.cleanupWith(async () => rmSync(directory,{ recursive:true,force:true }));
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-sha256','-nodes','-days','1',
    '-subj','/CN=synthetic-storybook-fixture','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem')],{ stdio:'ignore' });
  const loginOrigin='https://access-login.fixture.invalid',hostileOrigin='https://hostile.fixture.invalid';
  const observed:{ path:string;method:string;site?:string;mode?:string;destination?:string;status:number }[]=[];
  const jsAsset='/storybook'+[...assets.keys()].find(path => path.endsWith('.js'))!;
  const edge=createServer({ key:readFileSync(join(directory,'key.pem')),cert:readFileSync(join(directory,'cert.pem')) },(incoming,response) => {
    const target=new URL(incoming.url!,'https://'+incoming.headers.host);
    if (target.origin === loginOrigin) {
      if (target.pathname === '/return') { response.writeHead(302,{ location:OWNER_ORIGIN+'/storybook/' });response.end(); }
      else { response.setHeader('content-type','text/html');response.end('<a href="/return">Complete fixture login</a>'); }return;
    }
    if (target.origin === hostileOrigin) {
      response.setHeader('content-type','text/html');response.end(`<h1>Hostile fixture</h1><script src="${OWNER_ORIGIN}${jsAsset}"></script><iframe src="${OWNER_ORIGIN}/storybook/iframe.html"></iframe>`);return;
    }
    if (target.origin !== OWNER_ORIGIN) { response.writeHead(404);response.end();return; }
    const headers=incoming.headers;
    const outgoing=request(gateway.url+target.pathname+target.search,{ method:incoming.method,headers:{ ...headers,'cf-access-jwt-assertion':assertion } },result => {
      observed.push({ path:target.pathname,method:incoming.method!,site:headers['sec-fetch-site'] as string|undefined,
        mode:headers['sec-fetch-mode'] as string|undefined,destination:headers['sec-fetch-dest'] as string|undefined,status:result.statusCode! });
      response.writeHead(result.statusCode!,result.headers);result.pipe(response);
    });outgoing.on('error',() => { response.writeHead(503);response.end(); });incoming.pipe(outgoing);
  });
  edge.listen(0,'127.0.0.1');await once(edge,'listening');const address=edge.address();assert.ok(address && typeof address !== 'string');
  f.cleanupWith(() => new Promise<void>(resolve => { edge.closeAllConnections();edge.close(() => resolve()); }));
  const hosts=[OWNER_HOST,new URL(loginOrigin).hostname,new URL(hostileOrigin).hostname];
  const browser=await chromium.launch({ args:['--no-proxy-server','--host-resolver-rules='+
    [...hosts.map(host => `MAP ${host} 127.0.0.1:${address.port}`),'MAP * ~NOTFOUND'].join(',')] });
  f.cleanupWith(() => browser.close());
  const context=await browser.newContext({ ignoreHTTPSErrors:true,viewport:{ width:1440,height:1080 } });
  const page=await context.newPage(),errors:string[]=[];
  page.on('pageerror',error => errors.push(error.message));
  page.on('console',message => { if (message.type()==='error') errors.push(message.text()); });
  const artifacts=resolve(process.env.VV_OWNER_STORYBOOK_ARTIFACTS ?? 'storybook-artifacts');mkdirSync(artifacts,{ recursive:true });
  await page.goto(loginOrigin);await page.getByRole('link',{ name:'Complete fixture login' }).click();
  await page.frameLocator('#storybook-preview-iframe').getByRole('heading',{name:'Create a mock print job'}).first().waitFor();
  const navigation=observed.find(value => value.path==='/storybook/' && value.status===200)!;
  assert.deepEqual({ site:navigation.site,mode:navigation.mode,destination:navigation.destination },
    { site:'cross-site',mode:'navigate',destination:'document' });
  const frame=page.frameLocator('#storybook-preview-iframe');
  await frame.getByRole('heading',{ name:'Create a mock print job' }).first().waitFor();
  await frame.getByText(/No user STL supplied/).first().waitFor();
  assert.equal(await frame.getByRole('button',{name:'Post mock print job'}).first().isEnabled(),false);
  assert.ok(page.frames().some(value => value.url().includes('id=print-persistent-job-workspace--')),'Storybook root defaults to the fully mocked print example');
  assert.equal(observed.some(value => /^\/(session|queries|commands)(\/|$)/.test(value.path)),false,'Story fixtures never access persistent API/session');
  assert.equal((await context.cookies(OWNER_ORIGIN)).some(value => value.name===OWNER_COOKIE),false,'Static preview never creates an application session');
  assert.deepEqual(errors,[],'Manager and preview have no CSP/runtime failures');
  await page.screenshot({ path:join(artifacts,'owner-storybook-work-board-desktop.png'),fullPage:true });
  const axeSource=readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'),'utf8');
  for (const [id,heading] of [['print-mock-3d-print-journey--upload-required','A small print. An explicit agreement.'],['work-orders-work-order-board--representative','Work orders'],
    ['supply-independent-listings--raw-intermediate-and-finished-outputs','Buy'],
    ['demo-multi-stage-work-and-supply--eight-used-two-available','Inputs, outputs, and the next need.'],
    ['work-orders-house-work--completed-panels','One goal. Independent agreements.'],
    ['architecture-agents-operate-humans-supervise--overview','Agents operate. Humans supervise.'],
    ['economics-exploratory-model--base','What would the work order board earn?'],
    ['research-validation-plan--overview','Validate the problem before the marketplace.'],
    ['research-demo-opportunities--overview','Places to learn, discuss and demonstrate.']] as const) {
    for (const viewport of [{ width:1440,height:1080 },{ width:390,height:844 }]) {
      await page.setViewportSize(viewport);await page.goto(`${OWNER_ORIGIN}/storybook/iframe.html?id=${id}&viewMode=story`);
      await page.getByRole('heading',{ name:heading,exact:true }).waitFor();
      if (id.startsWith('print-')) {
        await page.getByText(/Upload required · no user design/).waitFor();
        await page.getByRole('button',{name:'Load synthetic 20 mm cube'}).click();
        for(const name of ['Approve mock print terms','Approve mock delivery plan','Simulate printing','Simulate courier dispatch','Simulate delivered event'])await page.getByRole('button',{name,exact:true}).click();
        assert.equal(await page.getByText('Simulated receipt acknowledged. No real goods moved.').count(),0);
        await page.getByRole('button',{name:'Acknowledge simulated receipt'}).click();
        await page.getByText('Simulated receipt acknowledged. No real goods moved.').waitFor();
      } else if (id.startsWith('architecture-')) {
        await page.getByRole('region',{ name:'Architecture text equivalent' }).waitFor();
        await page.getByText(/does not implement a universal human-approval policy/).waitFor();
        assert.equal(await page.getByRole('img',{ name:/Agents operate, humans supervise/ }).count(),1);
        assert.equal(await page.getByRole('button').count(),0,'Architecture is nonbinding and read-only');
      } else if (id.startsWith('economics-')) {
        await page.getByLabel('Exploratory model boundary').getByText(/Synthetic assumptions.*Local and non-persistent.*No provider connection or market command/).waitFor();
        await page.getByRole('table',{ name:'Monthly work order value — distinct stages, never added together' }).waitFor();
      } else if (id.startsWith('research-')) {
        await page.getByLabel('Evidence boundary').getByText(/No verified demand, GMV, LOIs or marketplace liquidity is established by this demo/).waitFor();
        assert.equal(await page.getByRole('button').count(),0,'Research has no action controls');
        assert.equal(await page.getByRole('textbox').count(),0,'Research has no editable inputs');
        await page.getByText('Discovery notes checked October 12, 2026 · Synthetic software evidence and business validation remain distinct.',{ exact:true }).waitFor();
      } else await page.getByText('Synthetic component fixture · interactions are local and non-persistent.',{ exact:false }).waitFor();
      if (id.startsWith('work-orders-work-order-board')) {
        const about=page.getByText('About work orders',{exact:true});if(!await about.evaluate(el=>(el.closest('details') as HTMLDetailsElement).open))await about.click();await page.getByText(/not escrow or verified funding/).waitFor();
        assert.equal(await page.getByRole('button',{name:/^Select /}).count(),4);
        assert.equal(await page.locator('.auction-mobile-facts').first().isVisible(),viewport.width===390,'Mobile rows retain quantity and budget');
      }
      if (id.startsWith('supply-independent-listings')) {
        for (const name of ['Illustrative raw blocks','Illustrative intermediate blanks','Illustrative wall panels']) await page.getByRole('button',{name:'Select '+name,exact:true}).waitFor();
      }
      if (id.startsWith('demo-multi-stage')) {
        await page.getByText('Available 2 each',{ exact:true }).waitFor();
        await page.getByText('8 used + 0 offered + 0 allocated + 2 available = 10 each',{ exact:true }).waitFor();
      }
      if (id.includes('house')) assert.equal(await page.getByRole('progressbar',{ name:'House kits acknowledged' }).getAttribute('value'),'0');
      await page.evaluate(axeSource);
      const result=await page.evaluate(async () => await (window as unknown as { axe:{ run:(document:Document,options:unknown)=>Promise<AxeResults> } }).axe.run(document,{ runOnly:{ type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'] } }));
      assert.deepEqual(result.violations.map(value => ({ id:value.id,targets:value.nodes.map(node => node.target) })),[]);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
      await page.screenshot({ path:join(artifacts,`owner-${id}-${viewport.width}.png`),fullPage:true });
    }
  }
  assert.deepEqual(errors,[],'Desktop and mobile static screens have no CSP/runtime failures');
  assert.equal(observed.some(value => /^\/(session|queries|commands)(\/|$)/.test(value.path)),false,'Work, supply, stages, economics and Research never call the persistent API');
  assert.equal(observed.some(value=>!value.path.startsWith('/storybook/')),false,'Canonical manager/preview/assets stay beneath the fixed subpath without legacy redirects');
  await page.goto(OWNER_ORIGIN+'/?path=/story/research-validation-plan--overview');
  await page.frameLocator('#storybook-preview-iframe').getByRole('heading',{name:'Validate the problem before the marketplace.'}).waitFor();
  assert.equal(new URL(page.url()).pathname,'/storybook/');await page.reload();
  await page.frameLocator('#storybook-preview-iframe').getByRole('heading',{name:'Validate the problem before the marketplace.'}).waitFor();
  await page.goto(OWNER_ORIGIN+'/iframe.html?id=research-validation-plan--overview&viewMode=story');
  await page.getByRole('heading',{name:'Validate the problem before the marketplace.'}).waitFor();assert.equal(new URL(page.url()).pathname,'/storybook/iframe.html');
  await page.goto(OWNER_ORIGIN+'/storybook');assert.equal(new URL(page.url()).pathname,'/storybook/');
  await page.goto(`${OWNER_ORIGIN}/storybook/iframe.html?id=work-orders-work-order-board--representative&viewMode=story`);
  await page.getByRole('heading',{ name:'Work orders',exact:true }).waitFor();
  await page.getByRole('link',{ name:/Open the .*synthetic.*app/ }).click();
  await page.getByRole('button',{ name:'Buyer human · review & publish',exact:false }).waitFor();assert.equal(new URL(page.url()).pathname,'/app');
  await page.getByRole('button',{ name:'Buyer human · review & publish',exact:false }).click();
  await page.getByRole('navigation',{ name:'Market workspace' }).waitFor();await page.locator('#market-app[aria-busy="false"]').waitFor();
  const cookie=(await context.cookies(OWNER_ORIGIN)).find(value => value.name===OWNER_COOKIE)!;
  assert.ok(cookie.secure && cookie.httpOnly);assert.equal(cookie.sameSite,'Strict');assert.equal(cookie.domain,OWNER_HOST);
  await page.reload();await page.getByRole('navigation',{ name:'Market workspace' }).waitFor();
  assert.equal((await context.cookies(OWNER_ORIGIN)).find(value => value.name===OWNER_COOKIE)!.value,cookie.value);
  // Real browser cross-site metadata for scripts, frames, reads and writes.
  await page.goto(hostileOrigin);await page.evaluate(async origin => {
    for (const path of ['/session','/queries/getWorkspace','/commands/createRequirementDraft']) {
      try { await fetch(origin+path,{ method:path==='/session' ? 'GET':'POST',credentials:'include',
        ...(path==='/session' ? {}:{ headers:{ 'content-type':'text/plain' },body:'{}' }) }); } catch { /* CORS also blocks reading failures. */ }
    }
  },OWNER_ORIGIN);
  for (const path of [jsAsset,'/storybook/iframe.html','/session','/queries/getWorkspace','/commands/createRequirementDraft'])
    assert.ok(observed.some(value => value.path===path && value.site==='cross-site' && value.status===403),path+' denied');
  assertion='forged';await page.goto(loginOrigin);
  const deniedResponse=page.waitForResponse(response => response.url()===OWNER_ORIGIN+'/storybook/' && response.request().isNavigationRequest());
  await page.getByRole('link',{ name:'Complete fixture login' }).click();assert.equal((await deniedResponse).status(),401);
  assert.doesNotMatch(await page.textContent('body') ?? '',/storybook|work-order board|personas|Synthetic component/i);
  assert.deepEqual(await f.snapshot(),before,'Static previews and preserved app session reads never mutate durable synthetic records');
});
