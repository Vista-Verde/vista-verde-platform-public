import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {startProducer} from '../../apps/producer-demo/server.ts';
import {ProducerClient} from '../../apps/producer-demo/requester.ts';
import {PRODUCER_VERSION,ProducerError} from '../../apps/producer-demo/protocol.ts';
import type {Exchange,Brief} from '../../apps/producer-demo/protocol.ts';
import {ProducerStore} from '../../apps/producer-demo/store.ts';

const brief:Brief={need:'Durable synthetic bracket',material:'PLA unverified',quantity:1,budgetMinor:4000,stl:'not_provided',scenario:'normal'};
const submit=(runId:string)=>({schemaVersion:PRODUCER_VERSION,runId,commandId:randomUUID(),brief});
const accept=(e:Exchange)=>({schemaVersion:PRODUCER_VERSION,runId:e.runId,commandId:randomUUID(),requestId:e.requestId,quoteId:e.quote.quoteId,quoteRevision:1,termsDigest:e.quote.termsDigest});
const reject=(call:Promise<unknown>,code:string)=>assert.rejects(call,e=>e instanceof ProducerError&&e.code===code);
const cleanups=new WeakMap<TestContext,Array<()=>void|Promise<void>>>();
function file(t:TestContext){
  const dir=mkdtempSync(join(tmpdir(),'vv-producer-recovery-')),stack:Array<()=>void|Promise<void>>=[];cleanups.set(t,stack);
  t.after(async()=>{try{for(const cleanup of stack.reverse())await cleanup();}finally{rmSync(dir,{recursive:true,force:true});}});return join(dir,'producer.sqlite');
}
async function processProducer(t:TestContext,stateFile:string,options:{progressMs?:[number,number];unitPriceMinor?:number}={}){
  const source=new URL('../../apps/producer-demo/server.ts',import.meta.url).href;
  const program=`const {startProducer}=await import(${JSON.stringify(source)});const s=await startProducer(${JSON.stringify({stateFile,...options})});process.send({url:s.url,runId:s.runId});process.once('SIGTERM',async()=>{await s.close();process.disconnect();});`;
  const child=spawn(process.execPath,['--max-old-space-size=48','--input-type=module','-e',program],{stdio:['ignore','ignore','ignore','ipc']});
  const stop=async(signal:NodeJS.Signals='SIGTERM')=>{if(child.exitCode!==null||child.signalCode!==null)return;const exit=once(child,'exit');child.kill(signal);await exit;};
  cleanups.get(t)!.push(()=>stop('SIGKILL'));
  const ready=await Promise.race([once(child,'message').then(([v])=>v as {url:string;runId:string}),once(child,'exit').then(()=>{throw new Error('Owned producer fixture exited before ready');})]);
  return{...ready,client:new ProducerClient(ready.url),stop};
}
async function until(client:ProducerClient,id:string,state:string){
  for(let i=0;i<250;i++){const view=await client.call('owner','read',{schemaVersion:PRODUCER_VERSION,requestId:id});if(view.exchange!.job!.state===state)return view.exchange!;await delay(20);}
  throw new Error('Expected producer checkpoint was not received');
}

test('durable producer: hard restart retains frozen terms and immutable receipts; downtime invents no progress',{timeout:15000},async t=>{
  const stateFile=file(t),first=await processProducer(t,stateFile,{progressMs:[600,1400]}),command=submit(first.runId);
  const quoted=await first.client.call('owner','submit',command),e=quoted.exchange!,approval=accept(e);
  const receipt=await first.client.call('owner','accept',approval);await first.stop('SIGKILL');await delay(1500);
  const second=await processProducer(t,stateFile,{unitPriceMinor:3000,progressMs:[5,10]});assert.equal(second.runId,first.runId);
  const recovered=(await second.client.call('owner','read',{schemaVersion:PRODUCER_VERSION,requestId:e.requestId})).exchange!;
  assert.deepEqual(recovered,receipt.exchange,'Offline time and changed process settings cannot fabricate progress or revise frozen terms');
  assert.deepEqual(await second.client.call('owner','submit',command),quoted);
  assert.deepEqual(await second.client.call('owner','accept',approval),receipt,'A lost committed reply remains recoverable after SIGKILL');
  await reject(second.client.call('owner','submit',{...command,brief:{...brief,quantity:2}}),'IDEMPOTENCY_CONFLICT');
  await reject(second.client.call('other','read',{schemaVersion:PRODUCER_VERSION,requestId:e.requestId}),'NOT_FOUND');
  await reject(second.client.call('owner','accept',accept(e)),'ALREADY_ACCEPTED');
  const final=await until(second.client,e.requestId,'completed_simulated');
  assert.equal(final.job!.jobId,receipt.exchange!.job!.jobId);assert.equal(final.job!.sequence,3);
  assert.deepEqual(final.messages.map(m=>m.sequence),[1,2,3,4,5,6,7]);assert.equal(new Set(final.messages.map(m=>m.messageId)).size,7);
  await second.stop('SIGKILL');const third=await processProducer(t,stateFile,{progressMs:[5,10]});await delay(50);
  assert.deepEqual((await third.client.call('owner','read',{schemaVersion:PRODUCER_VERSION,requestId:e.requestId})).exchange,final,'Terminal work is never rerun');
  assert.deepEqual(await third.client.call('owner','accept',approval),receipt);
});
test('durable producer: printing checkpoint recovers to recorded failure once, without offline completion',{timeout:10000},async t=>{
  const stateFile=file(t),first=await processProducer(t,stateFile,{progressMs:[30,600]}),e=(await first.client.call('owner','submit',{...submit(first.runId),brief:{...brief,scenario:'fail_after_start'}})).exchange!;
  const approval=accept(e),receipt=await first.client.call('owner','accept',approval),printing=await until(first.client,e.requestId,'printing');await first.stop('SIGKILL');await delay(650);
  const second=await processProducer(t,stateFile,{progressMs:[5,10]});
  assert.deepEqual((await second.client.call('owner','read',{schemaVersion:PRODUCER_VERSION,requestId:e.requestId})).exchange,printing);
  const failed=await until(second.client,e.requestId,'failed_simulated');assert.equal(failed.job!.sequence,3);assert.equal(failed.messages.length,7);
  assert.deepEqual(await second.client.call('owner','accept',approval),receipt);
});
test('durable producer: independent processes serialize competing acceptances and same-key retries',{timeout:12000},async t=>{
  const stateFile=file(t),a=await processProducer(t,stateFile,{progressMs:[100,300]}),b=await processProducer(t,stateFile,{progressMs:[100,300]});assert.equal(a.runId,b.runId);
  const e=(await a.client.call('owner','submit',submit(a.runId))).exchange!,commands=Array.from({length:12},()=>accept(e));
  const raced=await Promise.allSettled(commands.map((c,i)=>(i%2?a:b).client.call('owner','accept',c)));
  assert.equal(raced.filter(r=>r.status==='fulfilled').length,1);assert.equal(raced.filter(r=>r.status==='rejected'&&r.reason.code==='ALREADY_ACCEPTED').length,11);
  const winner=raced.findIndex(r=>r.status==='fulfilled'),receipt=(raced[winner] as PromiseFulfilledResult<unknown>).value;
  const retries=await Promise.all(Array.from({length:8},(_,i)=>(i%2?a:b).client.call('owner','accept',commands[winner])));retries.forEach(r=>assert.deepEqual(r,receipt));
  const final=await until(a.client,e.requestId,'completed_simulated');assert.equal(final.messages.filter(m=>m.kind==='ProducerAccepted').length,1);assert.equal(final.messages.length,7);
});
test('durable producer: receipt-write failure rolls back job and events, fails health, and permits exact retry after recovery',async t=>{
  const stateFile=file(t),first=await processProducer(t,stateFile),e=(await first.client.call('owner','submit',submit(first.runId))).exchange!,command=accept(e);
  const db=new DatabaseSync(stateFile);cleanups.get(t)!.push(()=>db.close());db.exec("CREATE TRIGGER fixture_write_failure BEFORE INSERT ON producer_replays BEGIN SELECT RAISE(ABORT,'owned fixture failure'); END");
  await reject(first.client.call('owner','accept',command),'UNAVAILABLE');await reject(first.client.health(),'UNAVAILABLE');
  const stored=JSON.parse(String(db.prepare('SELECT exchange_json FROM producer_exchanges').get()!.exchange_json)) as Exchange;
  assert.deepEqual(stored,e);assert.equal(db.prepare('SELECT count(*) AS n FROM producer_replays').get()!.n,1);
  await first.stop('SIGKILL');db.exec('DROP TRIGGER fixture_write_failure');const second=await processProducer(t,stateFile);
  const receipt=await second.client.call('owner','accept',command);assert.equal(receipt.exchange!.job!.sequence,1);
  assert.deepEqual(await second.client.call('owner','accept',command),receipt);
});
test('durable producer: quote expiry and bounded retention survive restart without resetting replay history',async t=>{
  const stateFile=file(t);let clock=Date.parse('2026-10-23T12:00:00Z');
  const first=await startProducer({stateFile,now:()=>clock,quoteTtlMs:1000});cleanups.get(t)!.push(()=>first.close());const a=new ProducerClient(first.url),command=submit(first.runId),receipt=await a.call('owner','submit',command);
  for(let i=1;i<100;i++)await a.call('owner','submit',submit(first.runId));await first.close();clock+=1000;
  const second=await startProducer({stateFile,now:()=>clock});cleanups.get(t)!.push(()=>second.close());const b=new ProducerClient(second.url);
  assert.deepEqual(await b.call('owner','submit',command),receipt);await reject(b.call('owner','submit',submit(second.runId)),'RUN_FULL');
  await reject(b.call('owner','accept',accept(receipt.exchange!)),'QUOTE_EXPIRED');
  await reject(b.call('owner','submit',{...command,runId:randomUUID()}),'RUN_CHANGED');
});
test('producer state file: refuse unrelated, corrupt, symlinked or relative files without resetting them',async t=>{
  const stateFile=file(t),db=new DatabaseSync(stateFile);db.exec('CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES(\'preserve\')');db.close();
  const bytes=readFileSync(stateFile);await assert.rejects(startProducer({stateFile}),/Producer state unavailable or invalid/);assert.deepEqual(readFileSync(stateFile),bytes);
  const link=stateFile+'.link';symlinkSync(stateFile,link);await assert.rejects(startProducer({stateFile:link}),/Invalid producer state file/);await assert.rejects(startProducer({stateFile:'relative.sqlite'}),/must be absolute/);
  const invalid=stateFile+'.invalid';writeFileSync(invalid,'not a database');await assert.rejects(startProducer({stateFile:invalid}),/Producer state unavailable or invalid/);assert.equal(readFileSync(invalid,'utf8'),'not a database');
  const truncated=stateFile+'.truncated',retained=new ProducerStore(truncated);retained.close();writeFileSync(truncated,'');
  await assert.rejects(startProducer({stateFile:truncated}),/Producer state unavailable or invalid/);assert.equal(readFileSync(truncated).length,0,'Truncated state is never silently initialized as a replacement run');
});
test('producer state file: retained schema version and metadata are validated without resetting a damaged run',t=>{
  const stateFile=file(t),first=new ProducerStore(stateFile),runId=first.runId;first.close();
  let db=new DatabaseSync(stateFile);db.exec('PRAGMA user_version=2');db.close();
  assert.throws(()=>new ProducerStore(stateFile),/Producer state unavailable or invalid/);
  db=new DatabaseSync(stateFile);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,2);assert.equal(db.prepare('SELECT run_id FROM producer_meta').get()!.run_id,runId);
  db.exec("PRAGMA user_version=1; UPDATE producer_meta SET run_id='damaged'");db.close();
  assert.throws(()=>new ProducerStore(stateFile),/Producer state unavailable or invalid/);
  db=new DatabaseSync(stateFile);assert.equal(db.prepare('SELECT run_id FROM producer_meta').get()!.run_id,'damaged');db.close();
});
