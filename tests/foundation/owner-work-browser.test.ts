import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,readFileSync,rmSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { chromium } from 'playwright';
import { createLocalJWKSet,exportJWK,generateKeyPair,SignJWT } from 'jose';
import { OWNER_COOKIE,OWNER_EMAIL,OWNER_HOST,OWNER_ISSUER,OWNER_ORIGIN,startOwnerAccess } from '../../apps/local/src/owner-access.ts';
import { productionStorybook,storybookArtifactDigest } from '../../apps/api/src/storybook.ts';
import {startProducer} from '../../apps/producer-demo/server.ts';
import {ProducerClient} from '../../apps/producer-demo/requester.ts';
import { startHttp } from '../../apps/api/src/http.ts';
import { WORK_PROFILE } from '../../apps/local/src/config.ts';
import { fixture } from './helpers.ts';
import { web,mcp } from './web-helpers.ts';
import { getOrder,getCommitment,financialSnapshot,marketSnapshot,noFinancialEffects,reconcileMarket } from './market-helpers.ts';
import { ownerWorkJourney } from './owner-work-journey.ts';
import { draft } from '../../packages/db/src/fixtures.ts';
import { ok } from './helpers.ts';
import { envelope } from '../../packages/contracts/src/index.ts';

test('local TLS owner fixture: real RSA sign-in opens the root app and preserves /app while performing persisted work posting, private response, dual consent and partial fulfillment', {timeout:120000},async t=>{
  const f=await fixture(t),producer=await startProducer({progressMs:[200,600]});f.cleanupWith(()=>producer.close());
  const api=await web(f,{legacy:false,producer:new ProducerClient(producer.url)}),finances=await financialSnapshot(f);
  const assets=productionStorybook(),artifactDigest=storybookArtifactDigest(assets),pair=await generateKeyPair('RS256'),audience='a'.repeat(64);
  const keys=createLocalJWKSet({keys:[{...await exportJWK(pair.publicKey),kid:'owner-work-fixture',alg:'RS256'}]});
  const now=Math.floor(Date.now()/1000);let assertion=await new SignJWT({iss:OWNER_ISSUER,aud:[audience],iat:now,exp:now+3600,
    sub:'owner-work-isolated-fixture',email:OWNER_EMAIL,type:'app'}).setProtectedHeader({alg:'RS256',kid:'owner-work-fixture'}).sign(pair.privateKey);
  const gateway=await startOwnerAccess(api.url,{audience},{keys,port:0,host:'127.0.0.1',storybook:{artifactDigest}});f.cleanupWith(()=>gateway.close());
  const directory=mkdtempSync(join(tmpdir(),'vv-owner-work-browser-'));f.cleanupWith(async()=>rmSync(directory,{recursive:true,force:true}));
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-sha256','-nodes','-days','1','-subj','/CN=synthetic-owner-work-fixture',
    '-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem')],{stdio:'ignore'});
  const loginOrigin='https://owner-login.fixture.invalid',hostileOrigin='https://owner-hostile.fixture.invalid';
  let dropNextWorkReply=false,dropNextProducerReply=false;
  const seen:{path:string;method:string;site?:string;mode?:string;destination?:string;status:number}[]=[];
  // An owned local TLS edge injects only the synthetic assertion into the real
  // verifier. This does not authenticate or exercise the real Cloudflare host.
  const tls=createServer({key:readFileSync(join(directory,'key.pem')),cert:readFileSync(join(directory,'cert.pem'))},(incoming,response)=>{
    const target=new URL(incoming.url!,'https://'+incoming.headers.host);
    if(target.origin===loginOrigin){if(target.pathname==='/return'){response.writeHead(302,{location:OWNER_ORIGIN+'/'});response.end();}
      else{response.setHeader('content-type','text/html');response.end('<a href="/return">Complete synthetic owner login</a>');}return;}
    if(target.origin===hostileOrigin){response.setHeader('content-type','text/html');response.end(`<h1>Hostile fixture</h1><script src="${OWNER_ORIGIN}/app.js"></script><iframe src="${OWNER_ORIGIN}/app"></iframe>`);return;}
    if(target.origin!==OWNER_ORIGIN){response.writeHead(404);response.end();return;}
    const outgoing=request(gateway.url+target.pathname+target.search,{method:incoming.method,headers:{...incoming.headers,'cf-access-jwt-assertion':assertion}},upstream=>{
      seen.push({path:target.pathname,method:incoming.method!,site:incoming.headers['sec-fetch-site'] as string|undefined,
        mode:incoming.headers['sec-fetch-mode'] as string|undefined,destination:incoming.headers['sec-fetch-dest'] as string|undefined,status:upstream.statusCode!});
      if(target.pathname==='/commands/postWorkOrder'&&dropNextWorkReply||target.pathname==='/producer-demo/accept'&&dropNextProducerReply){
        dropNextWorkReply=false;dropNextProducerReply=false;const interrupted={...upstream.headers,'content-length':'1048576'};delete interrupted['transfer-encoding'];
        response.writeHead(upstream.statusCode!,interrupted);response.write('{"ok":');
        upstream.resume();upstream.on('end',()=>response.destroy());
      }else{response.writeHead(upstream.statusCode!,upstream.headers);upstream.pipe(response);}
    });outgoing.on('error',()=>{response.writeHead(503);response.end();});incoming.pipe(outgoing);
  });
  tls.listen(0,'127.0.0.1');await once(tls,'listening');const address=tls.address();assert.ok(address&&typeof address!=='string');
  f.cleanupWith(()=>new Promise<void>(resolve=>{tls.closeAllConnections();tls.close(()=>resolve());}));
  const browser=await chromium.launch({args:['--no-proxy-server','--host-resolver-rules='+
    [OWNER_HOST,new URL(loginOrigin).hostname,new URL(hostileOrigin).hostname].map(host=>`MAP ${host} 127.0.0.1:${address.port}`).concat('MAP * ~NOTFOUND').join(',')]});
  f.cleanupWith(()=>browser.close());const context=await browser.newContext({ignoreHTTPSErrors:true}),page=await context.newPage(),errors:string[]=[];
  const legacyKey='vv.pending.buyer-agent',legacyValue=JSON.stringify({persona:'buyer-agent',operation:'createRequirementDraft',
    input:draft('canonical-legacy-unknown-key'),label:'UNKNOWN ORIGINAL CANONICAL DRAFT INTENT',uncertain:true});
  await context.addInitScript(({origin,key,value})=>{
    if(location.origin===origin&&sessionStorage.getItem('vv.fixture.original-intent-seeded')!=='true'){
      sessionStorage.setItem(key,value);sessionStorage.setItem('vv.fixture.original-intent-seeded','true');
    }
  },{origin:OWNER_ORIGIN,key:legacyKey,value:legacyValue});
  page.on('pageerror',error=>errors.push(error.message));await page.goto(loginOrigin);await page.getByRole('link',{name:'Complete synthetic owner login'}).click();
  await page.getByRole('button',{name:'Buyer agent · draft demand',exact:false}).waitFor();
  assert.ok(seen.some(entry=>entry.path==='/'&&entry.site==='cross-site'&&entry.mode==='navigate'&&entry.destination==='document'&&entry.status===200));
  assert.equal(new URL(page.url()).pathname,'/');assert.equal(await page.locator('#storybook-preview-iframe').count(),0,'The signed-in root is the existing React app');
  assert.equal(seen.some(entry=>entry.path.startsWith('/commands/')),false,'Opening the app never dispatches a business command');
  await page.getByRole('button',{name:'Buyer agent · draft demand',exact:false}).click();await page.locator('#market-app[aria-busy="false"]').waitFor();
  assert.equal(await page.getByRole('button',{name:'Retry saved request',exact:true}).count(),0,'An original-profile unknown intent is not a work-store retry');
  assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),legacyKey),legacyValue);
  const beforeExchange=await marketSnapshot(f),exchangeRequests:unknown[]=[];
  page.on('request',request=>{if(request.url().endsWith('/producer-demo/accept'))exchangeRequests.push(request.postDataJSON());});
  await page.goto(OWNER_ORIGIN+'/#exchange');await page.getByRole('button',{name:'Send brief to producer',exact:true}).click();
  await page.getByRole('heading',{name:'Conditional producer quote',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:/Approve \$25.00/}).isDisabled(),true);
  await page.getByLabel('Demo participant',{exact:true}).selectOption('buyer');await page.getByText(/Recent requests/).click();await page.getByRole('button',{name:/A small bracket/}).click();
  dropNextProducerReply=true;await page.getByRole('button',{name:/Approve \$25.00/}).click();
  await page.getByRole('button',{name:'Retry saved command',exact:true}).waitFor();await page.getByRole('heading',{name:'Completed · simulated',exact:true}).waitFor();
  const recoveredProducer=page.waitForResponse(response=>response.url().endsWith('/producer-demo/accept'));
  await page.getByRole('button',{name:'Retry saved command',exact:true}).click();assert.equal((await recoveredProducer).status(),200);
  await page.getByRole('heading',{name:'Completed · simulated',exact:true}).waitFor();assert.equal(exchangeRequests.length,2);assert.deepEqual(exchangeRequests[0],exchangeRequests[1]);
  assert.deepEqual(await marketSnapshot(f),beforeExchange,'Protected service communication changes no persisted market records');
  assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),legacyKey),legacyValue);
  await page.getByLabel('Demo participant',{exact:true}).selectOption('buyer-agent');await page.locator('#market-app[aria-busy="false"]').waitFor();
  const beforePrint=await marketSnapshot(f),printCommands=seen.filter(entry=>entry.path.startsWith('/commands/')).length;
  const printArtifacts=resolve(process.env.VV_WEB_ARTIFACTS??'web-artifacts');mkdirSync(printArtifacts,{recursive:true});
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:1080});
    for(const path of ['/','/app','/app/']){
      await page.goto(OWNER_ORIGIN+path+'#jobs');await page.locator('#market-app[aria-busy="false"]').waitFor();await page.reload();await page.locator('#market-app[aria-busy="false"]').waitFor();
      assert.equal(new URL(page.url()).pathname,path);assert.equal(new URL(page.url()).hash,'#jobs');assert.equal(await page.getByRole('link',{name:/Legacy production slots/}).count(),0);
    }
    await page.setViewportSize({width,height:1080});await page.goto(OWNER_ORIGIN+'/#print-demo');await page.reload();await page.locator('#market-app[aria-busy="false"]').waitFor();
    await page.getByText(/Upload required · no user design/).waitFor();assert.equal(await page.getByRole('link',{name:/Legacy production slots/}).count(),0);
    await page.getByRole('button',{name:'Load synthetic 20 mm cube'}).click();
    for(const name of ['Approve mock print terms','Approve mock delivery plan','Simulate printing','Simulate courier dispatch','Simulate delivered event'])await page.getByRole('button',{name,exact:true}).click();
    assert.equal(await page.getByText('Simulated receipt acknowledged. No real goods moved.').count(),0);await page.getByRole('button',{name:'Acknowledge simulated receipt'}).click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
    await page.screenshot({path:join(printArtifacts,`owner-print-local-${width}.png`),fullPage:true});
    assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),legacyKey),legacyValue);
  }
  assert.equal(seen.filter(entry=>entry.path.startsWith('/commands/')).length,printCommands,'The protected print planner sends no commands');
  assert.deepEqual(await marketSnapshot(f),beforePrint,'The protected planner creates no shared records or approvals');
  await page.setViewportSize({width:1440,height:1080});
  const evidence=await ownerWorkJourney(page,{origin:OWNER_ORIGIN,appPath:'/',need:'Isolated signed-owner integration: 12 synthetic panels'});
  for(const path of ['/','/app','/app/']){
    await page.goto(OWNER_ORIGIN+path+'#work/'+evidence.workOrderId);await page.locator('#market-app[aria-busy="false"]').waitFor();await page.reload();await page.locator('#market-app[aria-busy="false"]').waitFor();
    assert.match(await page.locator('main').innerText(),/Isolated signed-owner integration: 12 synthetic panels/);
  }
  assert.equal(seen.some(entry=>entry.path==='/commands/createRequirementDraft'),false,'The protected work app never dispatches the saved legacy command');
  assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),legacyKey),legacyValue,'Legacy recovery bytes remain available to the original runtime');
  const caller=await mcp(f,'buyer');assert.equal((await getOrder(caller.call,evidence.workOrderId)).remainingQuantity.value,4);
  assert.equal((await getCommitment(caller.call,evidence.commitmentId)).acknowledgedQuantity.value,5);
  for(const operation of ['postWorkOrder','respondToWorkOrder','confirmMarketProposal','reportMarketFulfillment','acknowledgeMarketFulfillment']){
    assert.ok(seen.some(entry=>entry.path===`/commands/${operation}`&&entry.method==='POST'&&entry.site==='same-origin'&&entry.status===200),operation+' traverses the protected real server');
  }
  const ownerCookie=(await context.cookies(OWNER_ORIGIN)).find(cookie=>cookie.name===OWNER_COOKIE)!;assert.ok(ownerCookie.secure&&ownerCookie.httpOnly);assert.equal(ownerCookie.sameSite,'Strict');
  await page.getByLabel('Demo participant',{exact:true}).selectOption('buyer-agent');await page.locator('#market-app[aria-busy="false"]').waitFor();
  await page.goto(OWNER_ORIGIN+'/app#post-work/PANEL-DEMO');await page.locator('#market-app[aria-busy="false"]').waitFor();
  const lostNeed='Owner work-profile lost reply preserves original terms',requests:unknown[]=[];
  page.on('request',request=>{if(request.url().endsWith('/commands/postWorkOrder')&&request.postDataJSON().need===lostNeed)requests.push(request.postDataJSON());});
  await page.getByLabel('Concrete need',{exact:true}).fill(lostNeed);await page.getByLabel('Quantity (each)',{exact:true}).fill('12');
  await page.getByLabel('Total budget (USD)',{exact:true}).fill('1200.00');await page.getByLabel('Delivery location',{exact:true}).fill('Original work-store recovery destination');
  dropNextWorkReply=true;
  // Sever only this owned TLS client reply after the real gateway/server commit.
  // Do not use route.fetch against the public hostname or touch real auth state.
  await page.getByRole('button',{name:'Post work order',exact:true}).evaluate(button=>{const form=button.closest('form')!;form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
  await page.getByRole('button',{name:'Retry saved request',exact:true}).waitFor();await page.locator('#market-app[aria-busy="false"]').waitFor();assert.equal(requests.length,1);
  await page.reload();await page.getByRole('button',{name:'Retry saved request',exact:true}).waitFor();
  const retry=page.waitForResponse(response=>response.url().endsWith('/commands/postWorkOrder')&&response.request().postDataJSON().need===lostNeed);
  await page.getByRole('button',{name:'Retry saved request',exact:true}).click();const recovered=ok(envelope.parse(await(await retry).json()));await page.locator('#market-app[aria-busy="false"]').waitFor();
  assert.equal(requests.length,2);assert.deepEqual(requests[1],requests[0]);assert.equal((await f.pool.query('SELECT count(*) FROM market_orders WHERE need=$1',[lostNeed])).rows[0].count,'1');
  assert.equal((await getOrder(caller.call,recovered.recordIds.workOrderId!)).budget?.minorUnits,120000);
  assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),legacyKey),legacyValue);assert.equal(seen.some(entry=>entry.path==='/commands/createRequirementDraft'),false);
  const before=await f.pool.query('SELECT count(*) FROM market_orders');await page.goto(hostileOrigin);
  await page.evaluate(async origin=>{try{await fetch(origin+'/commands/postWorkOrder',{method:'POST',credentials:'include',headers:{'content-type':'text/plain'},body:'{}'});}catch{/* CORS also withholds the denial. */}},OWNER_ORIGIN);
  assert.ok(seen.some(entry=>entry.path==='/app'&&entry.site==='cross-site'&&entry.status===403));
  assert.ok(seen.some(entry=>entry.path==='/commands/postWorkOrder'&&entry.site==='cross-site'&&entry.status===403));
  assert.equal((await f.pool.query('SELECT count(*) FROM market_orders')).rows[0].count,before.rows[0].count);
  await page.goto(OWNER_ORIGIN+'/app#work/'+evidence.workOrderId);await page.locator('#market-app[aria-busy="false"]').waitFor();
  const artifacts=resolve(process.env.VV_WEB_ARTIFACTS??'web-artifacts');mkdirSync(artifacts,{recursive:true});await page.screenshot({path:join(artifacts,'owner-work-persisted-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('button',{name:'Buyer agent · draft demand',exact:false}).waitFor();
  assert.notEqual((await context.cookies(OWNER_ORIGIN)).find(cookie=>cookie.name===OWNER_COOKIE)!.value,ownerCookie.value);
  assertion='forged';const denied=await page.goto(OWNER_ORIGIN+'/app');assert.equal(denied?.status(),401);assert.doesNotMatch(await page.locator('body').innerText(),/work-order board|Demo participant/);
  assert.deepEqual(errors,[]);await noFinancialEffects(f,finances);await reconcileMarket(f);
});

test('isolated loopback root preserves original pending bytes, rejects foreign work-profile intents and refuses the retained legacy UI', {timeout:30000},async t=>{
  const f=await fixture(t),before=await financialSnapshot(f);
  const personas=Object.fromEntries([['buyer-agent','Buyer agent · draft demand'],['buyer','Buyer human · review & publish']].map(([id,label])=>[id!,{label:label!,token:f.token(id!)}]));
  const api=await startHttp(f.connectionString,'local_test',{personas,legacy:false});f.cleanupWith(()=>api.close());
  const browser=await chromium.launch();f.cleanupWith(()=>browser.close());const context=await browser.newContext(),page=await context.newPage();
  const oldKey='vv.pending.buyer-agent',oldValue=JSON.stringify({persona:'buyer-agent',operation:'createRequirementDraft',input:draft('original-loopback-unknown-intent'),label:'ORIGINAL CANONICAL UNKNOWN INTENT',uncertain:true});
  await context.addInitScript(({key,value})=>{
    if(sessionStorage.getItem('vv.fixture.loopback-intent-seeded')!=='true'){
      sessionStorage.setItem(key,value);sessionStorage.setItem('vv.fixture.loopback-intent-seeded','true');
    }
  },{key:oldKey,value:oldValue});
  const commands:string[]=[];page.on('request',request=>{const path=new URL(request.url()).pathname;if(path.startsWith('/commands/'))commands.push(path);});
  await page.goto(api.url);await page.getByRole('button',{name:'Buyer agent · draft demand',exact:false}).click();await page.locator('#market-app[aria-busy="false"]').waitFor();
  assert.equal(await page.getByRole('button',{name:'Retry saved request',exact:true}).count(),0);assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),oldKey),oldValue);
  assert.equal(await page.getByRole('link',{name:/Legacy production slots/}).count(),0);
  for(const path of ['/legacy','/legacy/','/legacy?recover=original','/legacy/?recover=original'])assert.equal((await fetch(api.url+path)).status,403,'The isolated runtime cannot open original-profile UI paths');
  const foreignKey=`vv.pending.${WORK_PROFILE}.buyer-agent`,foreignValue=JSON.stringify({...JSON.parse(oldValue),profile:WORK_PROFILE});
  await page.evaluate(({key,value})=>sessionStorage.setItem(key,value),{key:foreignKey,value:foreignValue});await page.reload();await page.locator('#market-app[aria-busy="false"]').waitFor();
  await page.getByText('Saved-request storage is unavailable or unreadable. Commands are paused to preserve any earlier intent.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Retry saved request',exact:true}).count(),0);
  assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),foreignKey),foreignValue);assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),oldKey),oldValue);
  assert.deepEqual(commands,[],'Neither legacy intent is dispatched by the loopback MarketApp');await noFinancialEffects(f,before);await reconcileMarket(f);
});
