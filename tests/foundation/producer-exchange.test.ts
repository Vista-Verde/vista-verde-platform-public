import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer,request} from 'node:http';
import {once} from 'node:events';
import {startProducer} from '../../apps/producer-demo/server.ts';
import {ProducerClient} from '../../apps/producer-demo/requester.ts';
import {startProducerProcess} from '../../apps/producer-demo/process.ts';
import {PRODUCER_VERSION,ProducerError} from '../../apps/producer-demo/protocol.ts';
import type {Brief,Exchange} from '../../apps/producer-demo/protocol.ts';

const brief:Brief={need:'Desk organizer bracket',material:'PLA requested, unverified',quantity:1,budgetMinor:3000,stl:'not_provided',scenario:'normal'};
const submit=(runId:string,changes:Partial<Brief>={})=>({schemaVersion:PRODUCER_VERSION,runId,commandId:randomUUID(),brief:{...brief,...changes}});
const accept=(e:Exchange)=>({schemaVersion:PRODUCER_VERSION,runId:e.runId,commandId:randomUUID(),requestId:e.requestId,quoteId:e.quote.quoteId,quoteRevision:e.quote.revision,termsDigest:e.quote.termsDigest});
const rejects=(run:Promise<unknown>,code:string)=>assert.rejects(run,error=>error instanceof ProducerError&&error.code===code);
async function setup(t:TestContext,options:Parameters<typeof startProducer>[0]={}){
  const service=await startProducer(options);t.after(()=>service.close());return{service,client:new ProducerClient(service.url),runId:service.runId};
}
test('producer HTTP: correlated request/quote, explicit acceptance, producer-owned ordered status',async t=>{
  const {client,runId}=await setup(t,{progressMs:[25,60]}),input=submit(runId),quote=await client.call('buyer-org','submit',input),e=quote.exchange!;
  assert.equal(e.job,null);assert.equal(e.quote.priceMinor,2500);assert.match(e.quote.assumptions.join(' '),/No STL/);
  assert.deepEqual(e.messages.map(m=>[m.sender,m.kind,m.correlationId]),[['requester','SubmitPartRequest',input.commandId],['producer','QuoteReady',input.commandId]]);
  const approval=accept(e),receipt=await client.call('buyer-org','accept',approval);assert.equal(receipt.exchange!.job!.state,'queued');
  await delay(100);const observed=await client.call('buyer-org','read',{schemaVersion:PRODUCER_VERSION,runId,requestId:e.requestId});
  assert.equal(observed.exchange!.job!.state,'completed_simulated');assert.equal(observed.exchange!.job!.sequence,3);
  assert.deepEqual(observed.exchange!.messages.map(m=>m.sequence),[1,2,3,4,5,6,7]);
  assert.equal(observed.exchange!.messages[3]!.replyTo,approval.commandId);
  assert.deepEqual(await client.call('buyer-org','accept',approval),receipt,'same command gets immutable queued receipt after progress');
});
test('producer HTTP: racing accept commands create exactly one job and losing commands never change it',async t=>{
  const {client,runId}=await setup(t),e=(await client.call('buyer-org','submit',submit(runId))).exchange!;
  const attempts=await Promise.allSettled(Array.from({length:12},()=>client.call('buyer-org','accept',accept(e))));
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal(attempts.filter(r=>r.status==='rejected'&&r.reason.code==='ALREADY_ACCEPTED').length,11);
  const observed=await client.call('buyer-org','read',{schemaVersion:PRODUCER_VERSION,requestId:e.requestId});assert.equal(observed.exchange!.messages.filter(m=>m.kind==='ProducerAccepted').length,1);
});
test('producer HTTP: lost-response retry and concurrent same-key retry return identical receipts',async t=>{
  const {client,runId}=await setup(t),input=submit(runId);
  // Deliberately discard a completed wire reply to model an unknown client outcome.
  await fetch(client.url+'submit',{method:'POST',headers:{'content-type':'application/json','x-vv-requester':'buyer-org'},body:JSON.stringify(input)}).then(r=>r.arrayBuffer());
  const replies=await Promise.all(Array.from({length:8},()=>client.call('buyer-org','submit',input)));
  replies.forEach(r=>assert.deepEqual(r,replies[0]));assert.equal(replies[0]!.recent.length,1);
  await rejects(client.call('buyer-org','submit',{...input,brief:{...input.brief,quantity:2}}),'IDEMPOTENCY_CONFLICT');
  await rejects(client.call('buyer-org','accept',{...accept(replies[0]!.exchange!),commandId:input.commandId}),'IDEMPOTENCY_CONFLICT');
});
test('producer HTTP: strict inputs cannot select owner, upstream, approval or claim an STL',async t=>{
  const {client,runId}=await setup(t);
  for(const extra of [{organizationId:'other'},{approved:true},{upstream:'http://example.invalid'}])await rejects(client.call('buyer-org','submit',{...submit(runId),...extra}),'INVALID_REQUEST');
  await rejects(client.call('buyer-org','submit',submit(runId,{stl:'verified' as 'not_provided'})),'INVALID_REQUEST');
  await rejects(client.call('buyer-org','submit',submit(runId,{quantity:1.2})),'INVALID_REQUEST');
  for(const endpoint of ['http://localhost:4320','https://127.0.0.1:4320','http://127.0.0.1:4320/submit','http://127.0.0.1:4320/?a=b'])assert.throws(()=>new ProducerClient(endpoint));
});
test('producer HTTP: shared organization reads and retries; foreign namespaces see no records',async t=>{
  const {client,runId}=await setup(t),input=submit(runId),first=await client.call('organization-a','submit',input);
  const shared=await new ProducerClient(client.url.href).call('organization-a','read',{schemaVersion:PRODUCER_VERSION,requestId:first.exchange!.requestId});assert.equal(shared.exchange!.requestId,first.exchange!.requestId);
  assert.equal((await client.call('organization-b','read',{schemaVersion:PRODUCER_VERSION})).recent.length,0);
  await rejects(client.call('organization-b','read',{schemaVersion:PRODUCER_VERSION,requestId:first.exchange!.requestId}),'NOT_FOUND');
  await rejects(client.call('organization-b','accept',accept(first.exchange!)),'NOT_FOUND');
});
test('producer HTTP: budget, deadline, expiry and frozen-terms checks are authoritative',async t=>{
  let clock=Date.parse('2026-10-17T12:00:00Z');const {client,runId}=await setup(t,{now:()=>clock,quoteTtlMs:1000});
  const low=(await client.call('buyer','submit',submit(runId,{budgetMinor:2499}))).exchange!;await rejects(client.call('buyer','accept',accept(low)),'BUDGET_EXCEEDED');
  const late=(await client.call('buyer','submit',submit(runId,{deliveryBy:'2026-10-18T12:00:00Z'}))).exchange!;await rejects(client.call('buyer','accept',accept(late)),'DEADLINE_MISSED');
  const e=(await client.call('buyer','submit',submit(runId))).exchange!;await rejects(client.call('buyer','accept',{...accept(e),termsDigest:'a'.repeat(64)}),'TERMS_CHANGED');
  clock+=1000;await rejects(client.call('buyer','accept',accept(e)),'QUOTE_EXPIRED');
  assert.equal((await client.call('buyer','read',{schemaVersion:PRODUCER_VERSION,requestId:e.requestId})).exchange!.job,null);
});
test('producer HTTP: failed fixture remains terminal and approval retry cannot rerun a job',async t=>{
  const {client,runId}=await setup(t,{progressMs:[20,50]}),e=(await client.call('buyer','submit',submit(runId,{scenario:'fail_after_start'}))).exchange!,command=accept(e);
  const first=await client.call('buyer','accept',command);await delay(80);
  const failed=await client.call('buyer','read',{schemaVersion:PRODUCER_VERSION,requestId:e.requestId});assert.equal(failed.exchange!.job!.state,'failed_simulated');
  assert.deepEqual(await client.call('buyer','accept',command),first);await rejects(client.call('buyer','accept',accept(e)),'ALREADY_ACCEPTED');
});
test('producer child process: independently startable, HTTP healthy, restart changes run and rejects old commands',async t=>{
  const first=await startProducerProcess(0);t.after(()=>first.close());assert.notEqual(first.pid,process.pid);
  const health=await first.client.health(),input=submit(health.runId);await first.client.call('standalone','submit',input);await first.close();
  const second=await startProducerProcess(0);t.after(()=>second.close());assert.notEqual((await second.client.health()).runId,health.runId);
  await rejects(second.client.call('standalone','submit',input),'RUN_CHANGED');assert.equal((await second.client.call('standalone','read',{schemaVersion:PRODUCER_VERSION})).recent.length,0);
});
test('producer HTTP: exact Host, browser boundary, malformed body and method reject safely',async t=>{
  const {service,runId}=await setup(t),body=JSON.stringify(submit(runId));
  const badHeaders:Record<string,string>[]=[{host:'unexpected.invalid'},{origin:service.url},{cookie:'synthetic-marker'},{authorization:'synthetic-marker'}];
  for(const headers of badHeaders){
    const status=await new Promise<number>((resolve,reject)=>{const req=request(service.url+'/submit',{method:'POST',headers:{'content-type':'application/json','x-vv-requester':'buyer',...headers}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.end(body);});
    assert.equal(status,403);
  }
  const response=await fetch(service.url+'/submit',{method:'POST',headers:{'content-type':'application/json','x-vv-requester':'buyer'},body:'{'});assert.equal(response.status,400);
  assert.equal((await fetch(service.url+'/submit')).status,403);
});
test('requester bounds unresponsive, malformed and redirecting producer responses',async t=>{
  const server=createServer((req,res)=>{if(req.url==='/read'){res.writeHead(302,{location:'http://example.invalid'});res.end();}});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const addr=server.address();assert.ok(addr&&typeof addr!=='string');const client=new ProducerClient(`http://127.0.0.1:${addr.port}`,30);
  await rejects(client.health(),'UNAVAILABLE');await rejects(client.call('buyer','read',{schemaVersion:PRODUCER_VERSION}),'UNAVAILABLE');
});
