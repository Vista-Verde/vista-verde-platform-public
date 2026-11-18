import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ProducerClient} from './requester.ts';
import {healthSchema} from './protocol.ts';

/** A separate bounded process, in the existing pod, exposing loopback only. */
export async function startProducerProcess(port=4320,stateFile?:string){
  const file=new URL(import.meta.url.endsWith('.ts')?'./serve.ts':'./serve.js',import.meta.url);
  const child=fork(fileURLToPath(file),[],{execArgv:['--max-old-space-size=48'],env:{VV_PRODUCER_PORT:String(port),...(stateFile===undefined?{}:{VV_PRODUCER_STATE_FILE:stateFile})},stdio:['ignore','ignore','ignore','ipc']});
  let closing=false;let onFailure:()=>void=()=>{};
  const endpoint=await new Promise<string>((resolve,reject)=>{
    const timeout=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('Synthetic producer startup failed'));},5000);
    child.once('error',()=>{clearTimeout(timeout);reject(new Error('Synthetic producer unavailable'));});
    child.once('exit',()=>{clearTimeout(timeout);reject(new Error('Synthetic producer stopped'));if(!closing)onFailure();});
    child.once('message',(raw:unknown)=>{
      if(!raw||typeof raw!=='object'||!('ready' in raw)||raw.ready!==true||!('url' in raw)||typeof raw.url!=='string'){
        child.kill('SIGTERM');clearTimeout(timeout);reject(new Error('Invalid producer startup'));return;
      }
      clearTimeout(timeout);resolve(raw.url);
    });
  });
  let client:ProducerClient;
  try{client=new ProducerClient(endpoint);healthSchema.parse(await client.health());}catch{closing=true;child.kill('SIGTERM');throw new Error('Synthetic producer readiness failed');}
  return{client,pid:child.pid!,onFailure(callback:()=>void){onFailure=callback;if(!closing&&(child.exitCode!==null||child.signalCode!==null))callback();},async close(){
    if(closing)return;closing=true;
    if(child.exitCode!==null||child.signalCode!==null)return;
    await new Promise<void>(resolve=>{
      const timeout=setTimeout(()=>{child.kill('SIGKILL');},3000);timeout.unref();
      child.once('exit',()=>{clearTimeout(timeout);resolve();});child.kill('SIGTERM');
    });
  }};
}
