import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {request} from 'node:http';
import type {OutgoingHttpHeaders} from 'node:http';
import {createLocalJWKSet,exportJWK,generateKeyPair,SignJWT} from 'jose';
import {OWNER_HOST,OWNER_EMAIL,OWNER_ISSUER,OWNER_ORIGIN,startOwnerAccess} from '../../apps/local/src/owner-access.ts';
import {startProducer} from '../../apps/producer-demo/server.ts';
import {ProducerClient} from '../../apps/producer-demo/requester.ts';
import {PRODUCER_VERSION} from '../../apps/producer-demo/protocol.ts';
import {fixture} from './helpers.ts';
import {web,browserSession} from './web-helpers.ts';
import {financialSnapshot,marketSnapshot} from './market-helpers.ts';

test('protected producer exchange: existing gateway, browser checks, current grants and strict scope apply before every replay',async t=>{
  const f=await fixture(t),producer=await startProducer();f.cleanupWith(()=>producer.close());const api=await web(f,{legacy:false,producer:new ProducerClient(producer.url)});
  const pair=await generateKeyPair('RS256'),audience='a'.repeat(64),keys=createLocalJWKSet({keys:[{...await exportJWK(pair.publicKey),kid:'synthetic-producer-access',alg:'RS256'}]});
  const now=Math.floor(Date.now()/1000),assertion=await new SignJWT({iss:OWNER_ISSUER,aud:[audience],iat:now,exp:now+3600,sub:'synthetic-producer-owner',email:OWNER_EMAIL,type:'app'}).setProtectedHeader({alg:'RS256',kid:'synthetic-producer-access'}).sign(pair.privateKey);
  const gateway=await startOwnerAccess(api.url,{audience},{keys,port:0,host:'127.0.0.1'});f.cleanupWith(()=>gateway.close());
  async function wire(path:string,headers:OutgoingHttpHeaders={},input?:unknown){return await new Promise<{status:number;value:Record<string,unknown>;headers:OutgoingHttpHeaders}>((resolve,reject)=>{
    const safe=Object.fromEntries(Object.entries(headers).filter(([,value])=>value!==undefined));
    const req=request(gateway.url+path,{method:input===undefined?'GET':'POST',headers:{host:OWNER_HOST,...safe,...(input===undefined?{}:{'content-type':'application/json'})}},res=>{let text='';res.on('data',p=>{text+=String(p);});res.on('end',()=>resolve({status:res.statusCode!,value:JSON.parse(text),headers:res.headers}));});req.on('error',reject);req.end(input===undefined?undefined:JSON.stringify(input));});}
  const owner={'cf-access-jwt-assertion':assertion},boot=await wire('/session',owner);
  const entered=await wire('/session',{...owner,cookie:(boot.headers['set-cookie'] as string[])[0]!.split(';')[0],origin:OWNER_ORIGIN,'x-csrf-token':String(boot.value.csrf)},{persona:'buyer'});
  const headers={...owner,cookie:(entered.headers['set-cookie'] as string[])[0]!.split(';')[0],origin:OWNER_ORIGIN,'x-csrf-token':String(entered.value.csrf),'sec-fetch-site':'same-origin'};
  const read={schemaVersion:PRODUCER_VERSION},before=await financialSnapshot(f),market=await marketSnapshot(f);
  assert.equal((await wire('/producer-demo/read',headers,read)).status,200);
  for(const changes of [{'cf-access-jwt-assertion':undefined},{host:'unexpected.invalid'},{origin:'https://hostile.invalid'},{'x-csrf-token':'invalid'},{'sec-fetch-site':'cross-site'}])assert.notEqual((await wire('/producer-demo/read',{...headers,...changes},read)).status,200);
  assert.notEqual((await wire('/producer-demo/read?upstream=other',headers,read)).status,200);
  assert.notEqual((await wire('/producer-demo/accept/extra',headers,read)).status,200);
  const input={schemaVersion:PRODUCER_VERSION,runId:producer.runId,commandId:randomUUID(),brief:{need:'Protected synthetic bracket',material:'PLA unverified',quantity:1,budgetMinor:3000,stl:'not_provided',scenario:'normal'}};
  const submitted=await wire('/producer-demo/submit',headers,input);assert.equal(submitted.status,200);
  assert.equal((await wire('/producer-demo/submit',headers,{...input,organizationId:'spoofed'})).status,400);
  const local=await browserSession(api.url,'buyer-agent'),e=submitted.value.exchange as {requestId:string;quote:{quoteId:string;termsDigest:string}};
  const accept={schemaVersion:PRODUCER_VERSION,runId:producer.runId,commandId:randomUUID(),requestId:e.requestId,quoteId:e.quote.quoteId,quoteRevision:1,termsDigest:e.quote.termsDigest};
  assert.equal((await fetch(api.url+'/producer-demo/accept',{method:'POST',headers:local.headers,body:JSON.stringify(accept)})).status,403);
  assert.notEqual((await fetch(api.url+'/producer-demo/submit',{method:'POST',headers:{authorization:'Bearer '+f.token('buyer'),'content-type':'application/json'},body:JSON.stringify(input)})).status,200);
  assert.deepEqual(await financialSnapshot(f),before);assert.deepEqual(await marketSnapshot(f),market);
  await f.pool.query('UPDATE grants SET revoked=true WHERE id=$1',[f.context('buyer').grantId]);
  assert.notEqual((await wire('/producer-demo/submit',headers,input)).status,200,'replay rechecks current grant');
  assert.equal((await new ProducerClient(producer.url).call(f.context('buyer').organizationId,'read',read)).recent.length,1);
});
