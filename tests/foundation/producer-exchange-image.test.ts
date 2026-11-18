import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

test('exact compiled image: durable producer child recovers a killed run and immutable acceptance without offline progress',{timeout:30000},t=>{
  const image=process.env.VV_LOCAL_TEST_IMAGE;assert.ok(image,'Use the reviewed candidate image');
  const name='vv-producer-recovery-image-'+randomUUID();t.after(()=>{spawnSync('docker',['rm','-f',name],{stdio:'ignore'});});
  const program=`
    import assert from 'node:assert/strict';import{fork}from'node:child_process';import{once}from'node:events';import{randomUUID}from'node:crypto';import{setTimeout as delay}from'node:timers/promises';
    import{ProducerClient}from'./dist/apps/producer-demo/requester.js';import{PRODUCER_VERSION}from'./dist/apps/producer-demo/protocol.js';
    let child;async function start(){child=fork('./dist/apps/producer-demo/serve.js',[],{execArgv:['--max-old-space-size=48'],env:{VV_PRODUCER_PORT:'0',VV_PRODUCER_STATE_FILE:'/state/producer.sqlite'},stdio:['ignore','ignore','ignore','ipc']});const[ready]=await once(child,'message');return new ProducerClient(ready.url);}
    async function stop(signal){const exited=once(child,'exit');child.kill(signal);await exited;}
    try{
      let client=await start();const{runId}=await client.health(),owner='compiled-recovery';
      const command={schemaVersion:PRODUCER_VERSION,runId,commandId:randomUUID(),brief:{need:'Durable image bracket',material:'PLA unverified',quantity:1,budgetMinor:3000,stl:'not_provided',scenario:'normal'}};
      const quoted=await client.call(owner,'submit',command),e=quoted.exchange,approval={schemaVersion:PRODUCER_VERSION,runId,commandId:randomUUID(),requestId:e.requestId,quoteId:e.quote.quoteId,quoteRevision:1,termsDigest:e.quote.termsDigest};
      const receipt=await client.call(owner,'accept',approval);assert.equal(receipt.exchange.job.state,'queued');await stop('SIGKILL');await delay(4700);client=await start();assert.equal((await client.health()).runId,runId);
      assert.deepEqual((await client.call(owner,'read',{schemaVersion:PRODUCER_VERSION,requestId:e.requestId})).exchange,receipt.exchange);
      assert.deepEqual(await client.call(owner,'submit',command),quoted);assert.deepEqual(await client.call(owner,'accept',approval),receipt);
      let final;for(let i=0;i<60;i++){const view=await client.call(owner,'read',{schemaVersion:PRODUCER_VERSION,requestId:e.requestId});if(view.exchange.job.state==='completed_simulated'){final=view.exchange;break;}await delay(100);}
      assert.ok(final);assert.equal(final.job.jobId,receipt.exchange.job.jobId);assert.equal(final.messages.length,7);assert.equal(final.messages.filter(m=>m.kind==='ProducerAccepted').length,1);
      console.log(JSON.stringify({compiled:true,runRetained:true,immutableRetry:true,offlineProgressInvented:false,oneJob:true,state:final.job.state}));
    }finally{if(child&&child.exitCode===null&&child.signalCode===null)await stop('SIGKILL');}
  `;
  const result=execFileSync('docker',['run','--rm','-i','--pull=never','--name',name,'--label','vista-verde.fixture=producer-recovery-image','--network','none','--read-only','--memory','192m','--cpus','1','--tmpfs','/state:rw,nosuid,size=16m,uid=1000,gid=1000',image,'node','--max-old-space-size=48','--input-type=module','-e',program],{encoding:'utf8',timeout:25000,maxBuffer:1024*1024});
  assert.equal(JSON.parse(result).oneJob,true);
});

test('exact compiled image: producer runs independently without the marketplace, database or network and emits correlated terminal status',{timeout:30000},async t=>{
  const image=process.env.VV_LOCAL_TEST_IMAGE;assert.ok(image,'Use the reviewed offline candidate image');
  const name='vv-independent-producer-'+randomUUID();
  const docker=(args:string[])=>execFileSync('docker',args,{encoding:'utf8',timeout:15000,maxBuffer:1024*1024}).trim();
  docker(['run','--detach','--pull=never','--name',name,'--label','vista-verde.fixture=producer-exchange','--network','none','--read-only','--memory','128m','--cpus','1',image,'node','--max-old-space-size=48','dist/apps/producer-demo/serve.js']);
  t.after(()=>{docker(['rm','-f',name]);});
  await delay(500);
  const output=JSON.parse(docker(['exec',name,'node','--input-type=module','-e',`
    import assert from 'node:assert/strict';import{randomUUID}from'node:crypto';import{setTimeout as delay}from'node:timers/promises';
    import{ProducerClient}from'./dist/apps/producer-demo/requester.js';import{PRODUCER_VERSION}from'./dist/apps/producer-demo/protocol.js';
    const client=new ProducerClient('http://127.0.0.1:4320'),{runId}=await client.health(),owner='image-verification';
    const quoted=await client.call(owner,'submit',{schemaVersion:PRODUCER_VERSION,runId,commandId:randomUUID(),brief:{need:'Independent image bracket',material:'PLA unverified',quantity:1,budgetMinor:3000,stl:'not_provided',scenario:'normal'}}),e=quoted.exchange;assert.equal(e.job,null);
    const command={schemaVersion:PRODUCER_VERSION,runId,commandId:randomUUID(),requestId:e.requestId,quoteId:e.quote.quoteId,quoteRevision:1,termsDigest:e.quote.termsDigest};
    const accepted=await client.call(owner,'accept',command);await delay(5000);const observed=await client.call(owner,'read',{schemaVersion:PRODUCER_VERSION,runId,requestId:e.requestId});
    assert.equal(observed.exchange.job.state,'completed_simulated');assert.deepEqual(await client.call(owner,'accept',command),accepted);
    console.log(JSON.stringify({runId,requestId:e.requestId,quoteId:e.quote.quoteId,jobId:observed.exchange.job.jobId,state:observed.exchange.job.state,messageKinds:observed.exchange.messages.map(m=>m.kind),sequences:observed.exchange.messages.map(m=>m.sequence),standalone:true}));`]));
  assert.equal(output.state,'completed_simulated');assert.deepEqual(output.sequences,[1,2,3,4,5,6,7]);assert.equal(output.messageKinds.filter((kind:string)=>kind==='ProducerAccepted').length,1);
});
