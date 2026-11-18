import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {ProducerClient} from '../apps/producer-demo/requester.ts';
import {PRODUCER_VERSION} from '../apps/producer-demo/protocol.ts';
const client=new ProducerClient('http://127.0.0.1:4320'),owner='headless-demo';
const {runId}=await client.health();
const quote=await client.call(owner,'submit',{schemaVersion:PRODUCER_VERSION,runId,commandId:randomUUID(),brief:{need:'Headless synthetic bracket',material:'PLA requested; unverified',quantity:1,budgetMinor:3000,stl:'not_provided',scenario:'normal'}});
console.log(JSON.stringify({received:'QuoteReady',view:quote}));
const e=quote.exchange!;
// Running this explicitly named demo command authorizes only its synthetic acceptance.
const command={schemaVersion:PRODUCER_VERSION,runId,commandId:randomUUID(),requestId:e.requestId,quoteId:e.quote.quoteId,quoteRevision:e.quote.revision,termsDigest:e.quote.termsDigest};
const accepted=await client.call(owner,'accept',command);console.log(JSON.stringify({received:'ProducerAccepted',view:accepted}));
let sequence=1,finished=false;
for(let attempt=0;attempt<30;attempt++){
  const view=await client.call(owner,'read',{schemaVersion:PRODUCER_VERSION,runId,requestId:e.requestId});
  if(view.exchange!.job!.sequence>sequence){sequence=view.exchange!.job!.sequence;console.log(JSON.stringify({received:'JobStatus',view}));}
  if(['completed_simulated','failed_simulated'].includes(view.exchange!.job!.state)){finished=true;break;}
  await delay(500);
}
if(!finished)throw new Error('Producer did not report a terminal synthetic status within the bounded demo interval.');
