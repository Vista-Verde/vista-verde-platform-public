import {request} from 'node:http';
import {ProducerError,viewSchema,healthSchema,failureSchema,actionSchemas} from './protocol.ts';
import type {ProducerAction,ExchangeView} from './protocol.ts';

/** Fixed injected loopback endpoint. Browser input never selects a host or port. */
export class ProducerClient{
  readonly url:URL;
  readonly timeoutMs:number;
  constructor(endpoint:string,timeoutMs=2000){
    this.timeoutMs=timeoutMs;
    this.url=new URL(endpoint);
    if(this.url.protocol!=='http:'||this.url.hostname!=='127.0.0.1'||!/^\d+$/.test(this.url.port)||Number(this.url.port)<1024||Number(this.url.port)>65535
      ||this.url.username||this.url.password||this.url.pathname!=='/'||this.url.search||this.url.hash||timeoutMs<10||timeoutMs>10000)throw new ProducerError('INVALID_REQUEST');
  }
  async #wire(path:string,owner?:string,input?:unknown):Promise<unknown>{
    if(owner&&!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,99}$/.test(owner))throw new ProducerError('FORBIDDEN');
    const bytes=Buffer.from(input===undefined?'':JSON.stringify(input));if(bytes.length>16384)throw new ProducerError('INVALID_REQUEST');
    return await new Promise((resolve,reject)=>{
      const outgoing=request(new URL(path,this.url),{method:input===undefined?'GET':'POST',agent:false,
        headers:{...(owner?{'x-vv-requester':owner}:{}),...(input===undefined?{}:{'content-type':'application/json','content-length':bytes.length})}},res=>{
        const parts:Buffer[]=[];let size=0;
        res.on('data',(part:Buffer)=>{size+=part.length;if(size>131072)res.destroy(new Error('Bounded producer response exceeded'));else parts.push(part);});
        res.on('error',()=>reject(new ProducerError('UNAVAILABLE')));
        res.on('end',()=>{try{
          if(res.headers['content-type']!=='application/json')throw new ProducerError('UNAVAILABLE');
          const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));
          if(res.statusCode!==200){const failure=failureSchema.safeParse(value);throw new ProducerError(failure.success?failure.data.code:'UNAVAILABLE');}
          resolve(value);
        }catch(error){reject(error instanceof ProducerError?error:new ProducerError('UNAVAILABLE'));}});
      });
      const deadline=setTimeout(()=>outgoing.destroy(new Error('Producer deadline exceeded')),this.timeoutMs);deadline.unref();
      outgoing.on('close',()=>clearTimeout(deadline));outgoing.on('error',()=>reject(new ProducerError('UNAVAILABLE')));outgoing.end(bytes);
    });
  }
  async health(){try{return healthSchema.parse(await this.#wire('/health'));}catch{throw new ProducerError('UNAVAILABLE');}}
  async call(owner:string,action:ProducerAction,raw:unknown):Promise<ExchangeView>{
    const input=actionSchemas[action].safeParse(raw);if(!input.success)throw new ProducerError('INVALID_REQUEST');
    const output=viewSchema.safeParse(await this.#wire('/'+action,owner,input.data));if(!output.success)throw new ProducerError('UNAVAILABLE');
    const value=output.data;
    if(input.data.runId&&value.runId!==input.data.runId)throw new ProducerError('RUN_CHANGED');
    if('requestId' in input.data&&input.data.requestId&&value.exchange?.requestId!==input.data.requestId)throw new ProducerError('UNAVAILABLE');
    if(action==='submit'&&'commandId' in input.data&&value.exchange?.submitCommandId!==input.data.commandId)throw new ProducerError('UNAVAILABLE');
    if(value.exchange&&value.exchange.runId!==value.runId)throw new ProducerError('UNAVAILABLE');
    return value;
  }
}
