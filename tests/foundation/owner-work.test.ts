import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import type { OutgoingHttpHeaders } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createLocalJWKSet,exportJWK,generateKeyPair,SignJWT } from 'jose';
import { OWNER_HOST,OWNER_EMAIL,OWNER_ISSUER,OWNER_ORIGIN,startOwnerAccess } from '../../apps/local/src/owner-access.ts';
import { commandNames,envelope } from '../../packages/contracts/src/index.ts';
import type { Operation } from '../../packages/contracts/src/index.ts';
import { fixture,ok,failure } from './helpers.ts';
import { web,browserSession } from './web-helpers.ts';
import { draft,publication,purchase } from '../../packages/db/src/fixtures.ts';
import { workOrderInput,responseInput,confirmationInput,recordId,noMutation,getOrder,execute,reconcileMarket } from './market-helpers.ts';

const pair=await generateKeyPair('RS256'),audience='a'.repeat(64),keys=createLocalJWKSet({keys:[{...await exportJWK(pair.publicKey),kid:'owner-work-http-fixture',alg:'RS256'}]});
async function signed(changes:Record<string,unknown>={}){
  const now=Math.floor(Date.now()/1000);return new SignJWT({iss:OWNER_ISSUER,aud:[audience],iat:now,exp:now+3600,sub:'owner-work-http-subject',email:OWNER_EMAIL,type:'app',...changes})
    .setProtectedHeader({alg:'RS256',kid:'owner-work-http-fixture'}).sign(pair.privateKey);
}
async function wire(url:string,path:string,method:string,headers:OutgoingHttpHeaders={},input?:unknown){
  const bytes=Buffer.from(input===undefined?'':JSON.stringify(input));const safe=Object.fromEntries(Object.entries(headers).filter(([,value])=>value!==undefined));
  return new Promise<{status:number;headers:OutgoingHttpHeaders;text:string}>((resolve,reject)=>{
    const req=request(url+path,{method,headers:{host:OWNER_HOST,...safe,...(input===undefined?{}:{'content-type':'application/json','content-length':bytes.length})}},res=>{
      let text='';res.on('data',part=>{text+=String(part);});res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,text}));
    });req.on('error',reject);req.end(bytes);
  });
}
async function setup(t:Parameters<typeof fixture>[0]){
  const f=await fixture(t),api=await web(f,{legacy:false}),gateway=await startOwnerAccess(api.url,{audience},{keys,port:0,host:'127.0.0.1'});f.cleanupWith(()=>gateway.close());
  const assertion=await signed(),owner={'cf-access-jwt-assertion':assertion};
  async function login(persona:string){
    const boot=await wire(gateway.url,'/session','GET',owner);assert.equal(boot.status,200);const first=(boot.headers['set-cookie'] as string[])[0]!.split(';')[0]!;
    const response=await wire(gateway.url,'/session','POST',{...owner,cookie:first,origin:OWNER_ORIGIN,'sec-fetch-site':'same-origin','x-csrf-token':JSON.parse(boot.text).csrf},{persona});assert.equal(response.status,200);
    const cookie=(response.headers['set-cookie'] as string[])[0]!.split(';')[0]!,headers={...owner,cookie,origin:OWNER_ORIGIN,'sec-fetch-site':'same-origin','x-csrf-token':JSON.parse(response.text).csrf};
    return{headers,cookie,call:async(operation:Operation,input:unknown,overrides:OutgoingHttpHeaders={})=>{
      const command=(commandNames as readonly string[]).includes(operation),result=await wire(gateway.url,`/${command?'commands':'queries'}/${operation}`,'POST',{...headers,...overrides},input);
      return{...result,receipt:envelope.parse(JSON.parse(result.text))};
    }};
  }
  return{f,api,gateway,owner,login};
}

test('owner work HTTP: owner assertion, exact Host/Origin, CSRF and strict authority inputs protect the new work commands',async t=>{
  const {f,api,gateway,owner,login}=await setup(t),buyer=await login('buyer'),input=workOrderInput('owner-negative-post');
  // Model an original document already open at rollout: it receives a valid
  // fresh owner session/CSRF and replays its valid old unknown-outcome payload.
  const oldDocument=await login('buyer-agent'),oldProducer=await login('producer-a'),originalIntent=draft('canonical-unknown-before-work-rollout');
  const unpublished=ok(await f.application.execute('createRequirementDraft',draft('owned-old-publication-fixture'),f.context('buyer-agent')));
  await f.publish('owned-old-live-slot');const expiresAt=new Date(Date.now()+1000).toISOString();await f.publish('owned-old-expired-slot',6000,'housing-panel',expiresAt);
  await delay(Math.max(0,Date.parse(expiresAt)-Date.now()+20));const foundationBefore=await f.snapshot();
  const originalWrites=[
    {operation:'createRequirementDraft',input:originalIntent,session:oldDocument},
    {operation:'publishRequirement',input:publication(unpublished.recordIds.requirementId!,'old-document-new-slot'),session:buyer},
    {operation:'purchaseSlot',input:purchase('owned-old-live-slot','old-document-purchase'),session:oldProducer},
    {operation:'withdrawUnpurchasedSlot',input:{...purchase('owned-old-live-slot','old-document-withdraw'),reason:'Original retained document withdrawal'},session:buyer},
    {operation:'processExpiredSlot',input:purchase('owned-old-expired-slot','old-document-expiry'),session:buyer}
  ] as const;
  for(const request of originalWrites){
    await noMutation(f,async()=>{const result=await request.session.call(request.operation,request.input);assert.equal(result.status,403);failure(result.receipt,'FORBIDDEN');});
    assert.deepEqual(await f.snapshot(),foundationBefore,'The isolated runtime preserves requirements, slots, holds, commitments, audit/outbox and idempotency for '+request.operation);
  }
  for(const headers of [{origin:'https://hostile.invalid'},{origin:undefined},{host:'hostile.invalid','x-forwarded-host':OWNER_HOST},
    {'x-csrf-token':undefined},{'x-csrf-token':'forged'},{'sec-fetch-site':'cross-site'},{authorization:`Bearer ${f.token('buyer')}`}]){
    await noMutation(f,async()=>{const result=await buyer.call('postWorkOrder',input,headers);assert.equal(result.status,403);failure(result.receipt,'FORBIDDEN');});
  }
  for(const extra of [{actorId:'producer-a'},{organizationId:'producer-a-org'},{funded:true},{approved:true}]){
    await noMutation(f,async()=>failure((await buyer.call('postWorkOrder',{...input,...extra})).receipt,'VALIDATION_FAILED'));
  }
  for(const assertion of [undefined,'forged',await signed({aud:['b'.repeat(64)]}),await signed({email:'foreign@fixture.invalid'}),await signed({exp:Math.floor(Date.now()/1000)-1})]){
    await noMutation(f,async()=>{const result=await wire(gateway.url,'/commands/postWorkOrder','POST',{...buyer.headers,'cf-access-jwt-assertion':assertion},input);assert.equal(result.status,401);assert.doesNotMatch(result.text,/personas|need|budget|grant/i);});
  }
  const local=await browserSession(api.url,'buyer');await noMutation(f,async()=>failure((await buyer.call('postWorkOrder',input,{cookie:local.cookie})).receipt,'FORBIDDEN'));
  for(const path of ['/','/app','/app/'])await noMutation(f,async()=>{
    const document=await wire(gateway.url,path,'GET',owner);assert.equal(document.status,200);assert.match(document.text,/data-legacy-workspace="disabled"/);
    assert.match(String(document.headers['content-security-policy']),/frame-ancestors 'none'/);
    assert.equal((await wire(gateway.url,path,'GET',{})).status,401,'App aliases require the same verified owner');
  });
  const badPaths=['/app?upstream=http://hostile.invalid','/commands/postWorkOrder?actorId=buyer','/storybook/commands/postWorkOrder'];
  for(const path of badPaths)assert.equal((await wire(gateway.url,path,'GET',owner)).status,403,'No upstream/actor selector or prefixed API alias is accepted');
  const retained=await web(f),retainedSession=await browserSession(retained.url,'buyer-agent');
  ok((await retainedSession.call('createRequirementDraft',originalIntent)).receipt);
  assert.notDeepEqual(await f.snapshot(),foundationBefore,'The same reviewed legacy payload remains valid in the default retained runtime');
  await f.reconcile();
  await reconcileMarket(f);
});

test('owner work HTTP: protected sessions use current party grants for private responses, confirmations and historical replay',async t=>{
  const {f,gateway,login}=await setup(t),buyer=await login('buyer'),a=await login('producer-a'),b=await login('producer-b');
  const workId=recordId(ok((await buyer.call('postWorkOrder',workOrderInput('owner-explicit-work'))).receipt),'workOrderId');
  const input=responseInput('owner-private-response',workId),proposed=ok((await a.call('respondToWorkOrder',input)).receipt),proposalId=recordId(proposed,'proposalId');
  await noMutation(f,async()=>assert.deepEqual((await a.call('respondToWorkOrder',input)).receipt,proposed));
  await noMutation(f,async()=>failure((await b.call('getMarketProposal',{proposalId})).receipt,'FORBIDDEN'));
  ok((await buyer.call('confirmMarketProposal',confirmationInput('owner-buyer-consent',proposalId,1))).receipt);
  await f.pool.query('UPDATE grants SET revoked=true WHERE id=$1',[f.context('buyer').grantId]);
  await noMutation(f,async()=>{const blocked=await a.call('confirmMarketProposal',confirmationInput('owner-final-blocked',proposalId,2));assert.equal(blocked.status,403);failure(blocked.receipt,'FORBIDDEN');});
  await f.pool.query('UPDATE grants SET revoked=false WHERE id=$1',[f.context('buyer').grantId]);
  const committed=ok((await a.call('confirmMarketProposal',confirmationInput('owner-final-approved',proposalId,2))).receipt);assert.ok(committed.recordIds.commitmentId);
  assert.equal((await getOrder(execute(f,'buyer'),workId)).budgetCommitted?.minorUnits,72000);
  await f.pool.query('UPDATE grants SET market_scopes=ARRAY[]::text[] WHERE id=$1',[f.context('producer-a').grantId]);
  await noMutation(f,async()=>failure((await a.call('respondToWorkOrder',input)).receipt,'FORBIDDEN'));
  await f.pool.query('UPDATE grants SET revoked=true WHERE id=$1',[f.context('producer-a').grantId]);
  await noMutation(f,async()=>{const denied=await a.call('respondToWorkOrder',input);assert.equal(denied.status,401);failure(denied.receipt,'UNAUTHENTICATED');});
  await f.pool.query("UPDATE grants SET revoked=false,market_scopes=ARRAY['*'] WHERE id=$1",[f.context('producer-a').grantId]);
  const logout=await wire(gateway.url,'/session','DELETE',a.headers);assert.equal(logout.status,200);
  await noMutation(f,async()=>failure((await a.call('respondToWorkOrder',input)).receipt,'FORBIDDEN'));
  await reconcileMarket(f);
});
