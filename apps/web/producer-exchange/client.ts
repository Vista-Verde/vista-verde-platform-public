import {actionSchemas,viewSchema,ProducerError,producerCodes} from '../../producer-demo/protocol.ts';
import type {ProducerAction,ExchangeView,ProducerCode} from '../../producer-demo/protocol.ts';

export type PendingExchange={action:'submit'|'accept';input:unknown};
export const storageKey=(persona:string)=>`vv.producer-demo.v1.${persona}`;
export function readPending(storage:Storage,key:string):PendingExchange|undefined{
  const text=storage.getItem(key);if(!text)return;
  const raw:unknown=JSON.parse(text);
  if(!raw||typeof raw!=='object'||!('action' in raw)||!('input' in raw)||Object.keys(raw).length!==2
    ||raw.action!=='submit'&&raw.action!=='accept')throw new Error('Saved exchange intent cannot be read. Preserve it before clearing storage.');
  return{action:raw.action,input:actionSchemas[raw.action].parse(raw.input)};
}
export async function exchangeCall(csrf:string,action:ProducerAction,input:unknown):Promise<ExchangeView>{
  try{
    const response=await fetch('/producer-demo/'+action,{method:'POST',credentials:'same-origin',redirect:'error',
      headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(actionSchemas[action].parse(input))});
    const value:unknown=await response.json();
    if(!response.ok){
      const code=value&&typeof value==='object'&&'code' in value?value.code:undefined;
      throw new ProducerError(typeof code==='string'&&(producerCodes as readonly string[]).includes(code)?code as ProducerCode:'FORBIDDEN');
    }
    return viewSchema.parse(value);
  }catch(error){if(error instanceof ProducerError)throw error;throw new ProducerError('UNAVAILABLE');}
}
