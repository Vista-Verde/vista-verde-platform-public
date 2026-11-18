import {createServer} from 'node:http';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {PRODUCER_VERSION,actionSchemas,ProducerError,dollars} from './protocol.ts';
import type {ProducerAction,Brief,Exchange,ExchangeView} from './protocol.ts';
import {ProducerStore} from './store.ts';
import type {ProducerRecord} from './store.ts';

function demand(value:unknown,code:ConstructorParameters<typeof ProducerError>[0]='INVALID_REQUEST'):asserts value{if(!value)throw new ProducerError(code);}
const headers={'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; frame-ancestors 'none'"};
export async function readProducerJson(req:IncomingMessage):Promise<unknown>{
  demand(req.headers['content-type']==='application/json');
  demand(!req.headers['content-length']||/^\d+$/.test(req.headers['content-length'])&&Number(req.headers['content-length'])<=16384);
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req){size+=chunk.length;demand(size<=16384);chunks.push(chunk);}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new ProducerError('INVALID_REQUEST');}
}
export function sendProducerError(res:ServerResponse,error:unknown){
  const code=error instanceof ProducerError?error.code:'INVALID_REQUEST';
  res.writeHead(code==='UNAVAILABLE'?503:code==='FORBIDDEN'?403:400,headers);
  res.end(JSON.stringify({schemaVersion:PRODUCER_VERSION,ok:false,code,retryable:code==='UNAVAILABLE'}));
}
export async function startProducer(options:{port?:number;stateFile?:string;unitPriceMinor?:number;quoteTtlMs?:number;progressMs?:[number,number];now?:()=>number}={}){
  const port=options.port??0;demand(Number.isInteger(port)&&port>=0&&port<=65535);
  const unitPrice=options.unitPriceMinor??2000,ttl=options.quoteTtlMs??300000,progress=options.progressMs??[1500,4500];
  demand(Number.isSafeInteger(unitPrice)&&unitPrice>0&&unitPrice<=100000);demand(ttl>0&&ttl<=3600000);
  demand(progress.every(Number.isSafeInteger)&&progress[0]>0&&progress[1]>progress[0]&&progress[1]<=60000);
  const now=options.now??Date.now,store=new ProducerStore(options.stateFile),runId=store.runId;
  const timers=new Map<string,ReturnType<typeof setTimeout>>();let authority='',closing=false;
  const at=()=>new Date(now()).toISOString();
  function view(owner:string,exchange:Exchange|null):ExchangeView{
    return structuredClone({schemaVersion:PRODUCER_VERSION,ok:true,runId,observedAt:at(),requester:'deterministic',producer:'simulated',exchange,
      recent:store.recent(owner)});
  }
  function owned(owner:string,id:string){const r=store.get(owner,id);demand(r,'NOT_FOUND');return r;}
  function append(e:Exchange,sender:'requester'|'producer',kind:Exchange['messages'][number]['kind'],correlationId:string,summary:string,replyTo:string|null=null){
    e.messages.push({messageId:randomUUID(),correlationId,replyTo,sequence:e.messages.length+1,sender,kind,at:at(),summary});
  }
  function schedule(record:ProducerRecord){
    const {exchange:e,simulation}=record,job=e.job;
    if(closing||!store.healthy||!simulation||!job||!['queued','printing'].includes(job.state)||timers.has(e.requestId))return;
    // Restart re-arms only the last committed checkpoint. Offline wall time
    // never implies printing/completion; each new event commits when produced.
    const timer=setTimeout(()=>{
      timers.delete(e.requestId);if(closing)return;
      try{
        const next=store.transaction(()=>{
          const current=store.get(record.owner,e.requestId),actual=current?.exchange.job;
          if(!current||!actual||actual.jobId!==job.jobId||actual.sequence!==job.sequence||actual.state!==job.state)return null;
          actual.state=actual.state==='queued'?'printing':current.exchange.brief.scenario==='fail_after_start'?'failed_simulated':'completed_simulated';actual.sequence++;
          append(current.exchange,'producer','JobStatus',simulation.commandId,`${actual.state} · producer-originated simulated update. No physical file or machine was used.`,simulation.commandId);
          store.save(current);return current;
        });
        if(next)schedule(next);
      }catch{ /* The store fails closed and health/commands report UNAVAILABLE. */ }
    },simulation.delays[job.state==='queued'?0:1]);timer.unref();timers.set(e.requestId,timer);
  }
  function quote(brief:Brief){
    const priceMinor=500+brief.quantity*unitPrice,expiresAt=new Date(now()+ttl).toISOString();
    const blockers:string[]=[];
    if(priceMinor>brief.budgetMinor)blockers.push('Quote exceeds the stated budget; no funds are reserved and approval is blocked.');
    if(brief.deliveryBy&&Date.parse(brief.deliveryBy)<now()+48*3600000)blockers.push('The declared deadline is earlier than the simulated 48-hour lead time.');
    const termsDigest=createHash('sha256').update(JSON.stringify({brief,priceMinor,expiresAt,leadHours:48})).digest('hex');
    return {quoteId:randomUUID(),revision:1 as const,priceMinor,currency:'USD' as const,leadHours:48,leadStarts:'producer_acceptance' as const,expiresAt,termsDigest,blockers,
      assumptions:['Conditional synthetic quote. No STL has been supplied; no geometry or printability was verified.',`Material requirement: ${brief.material}. Availability and compatibility are simulated, not verified.`,
        `USD5 setup plus ${dollars(unitPrice)} per counted part (synthetic fixture). Material is included once; no shipping or payment.`,
        '48-hour mock lead time starts at producer acceptance. Demo progress runs in seconds and is not a physical promise.']};
  }
  function execute(owner:string,action:ProducerAction,raw:unknown):ExchangeView{
    if(action==='read'){
      const input=actionSchemas.read.parse(raw);demand(!input.runId||input.runId===runId,'RUN_CHANGED');
      return view(owner,input.requestId?owned(owner,input.requestId).exchange:null);
    }
    const input=action==='submit'?actionSchemas.submit.parse(raw):actionSchemas.accept.parse(raw);
    demand(input.runId===runId,'RUN_CHANGED');
    const fingerprint=createHash('sha256').update(JSON.stringify({action,input})).digest('hex'),prior=store.replay(owner,input.commandId);
    if(prior){demand(prior.fingerprint===fingerprint,'IDEMPOTENCY_CONFLICT');return structuredClone(prior.receipt);}
    demand(store.replayCount()<300,'RUN_FULL');let e:Exchange;
    if('brief' in input){
      demand(store.recordCount()<100,'RUN_FULL');
      e={requestId:randomUUID(),runId,revision:1,submitCommandId:input.commandId,brief:input.brief,quote:quote(input.brief),createdAt:at(),job:null,messages:[]};
      append(e,'requester','SubmitPartRequest',input.commandId,`Request received: ${input.brief.need}; ${input.brief.quantity} each; material ${input.brief.material}; budget ${dollars(input.brief.budgetMinor)}. STL not provided.`);
      append(e,'producer','QuoteReady',input.commandId,`Conditional simulated quote ${dollars(e.quote.priceMinor)}; lead ${e.quote.leadHours} hours after acceptance.`,input.commandId);
      store.insert({owner,exchange:e,simulation:null});
    }else{
      const record=owned(owner,input.requestId);e=record.exchange;
      demand(input.quoteId===e.quote.quoteId&&input.quoteRevision===e.quote.revision&&input.termsDigest===e.quote.termsDigest,'TERMS_CHANGED');
      demand(!e.job,'ALREADY_ACCEPTED');demand(now()<Date.parse(e.quote.expiresAt),'QUOTE_EXPIRED');
      demand(e.quote.priceMinor<=e.brief.budgetMinor,'BUDGET_EXCEEDED');
      demand(!e.brief.deliveryBy||Date.parse(e.brief.deliveryBy)>=now()+e.quote.leadHours*3600000,'DEADLINE_MISSED');
      const acceptedAt=at();e.job={jobId:randomUUID(),quoteId:e.quote.quoteId,acceptedAt,producerAcceptedAt:acceptedAt,state:'queued',sequence:1};
      append(e,'requester','AcceptQuote',input.commandId,`Buyer explicitly approved quote ${e.quote.quoteId}, revision ${e.quote.revision}, ${dollars(e.quote.priceMinor)}.`);
      append(e,'producer','ProducerAccepted',input.commandId,`Simulated producer accepted the frozen terms and queued synthetic job ${e.job.jobId}.`,input.commandId);
      append(e,'producer','JobStatus',input.commandId,'queued · simulated producer job; no machine control.',input.commandId);
      record.simulation={commandId:input.commandId,delays:[progress[0],progress[1]-progress[0]]};store.save(record);
    }
    const receipt=view(owner,e);store.remember(owner,input.commandId,fingerprint,receipt);return receipt;
  }
  const server=createServer(async(req,res)=>{try{
    demand(req.socket.remoteAddress==='127.0.0.1'&&req.headers.host===authority,'FORBIDDEN');
    demand(!req.headers.origin&&!req.headers.authorization&&!req.headers.cookie,'FORBIDDEN');
    if(req.method==='GET'&&req.url==='/health'){demand(store.healthy,'UNAVAILABLE');res.writeHead(200,headers);res.end(JSON.stringify({schemaVersion:PRODUCER_VERSION,runId,healthy:true}));return;}
    const action=req.url?.match(/^\/(read|submit|accept)$/)?.[1] as ProducerAction|undefined;
    demand(req.method==='POST'&&action,'FORBIDDEN');
    const owner=req.headers['x-vv-requester'];demand(typeof owner==='string'&&/^[A-Za-z0-9][A-Za-z0-9:_-]{0,99}$/.test(owner),'FORBIDDEN');
    const input=actionSchemas[action].safeParse(await readProducerJson(req));demand(input.success);
    const result=store.transaction(()=>execute(owner,action,input.data),action!=='read');
    if(action==='accept'&&result.exchange){const record=store.transaction(()=>store.get(owner,result.exchange!.requestId),false);if(record)schedule(record);}
    res.writeHead(200,headers);res.end(JSON.stringify(result));
  }catch(error){sendProducerError(res,error);}});
  server.requestTimeout=3000;server.headersTimeout=3000;server.maxHeadersCount=20;
  let recovering:ProducerRecord[];
  try{recovering=store.transaction(()=>store.active(),false);}catch(error){store.close();throw error;}
  server.listen(port,'127.0.0.1');try{await once(server,'listening');}catch(error){store.close();throw error;}const address=server.address();if(!address||typeof address==='string')throw new Error('Producer loopback unavailable');
  authority=`127.0.0.1:${address.port}`;
  for(const record of recovering)schedule(record);
  return {url:`http://${authority}`,runId,async close(){if(closing)return;closing=true;for(const timer of timers.values())clearTimeout(timer);timers.clear();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}};
}
