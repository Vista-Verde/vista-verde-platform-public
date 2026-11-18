import {useEffect,useRef,useState} from 'react';
import {PRODUCER_VERSION,ProducerError,briefSchema} from '../../producer-demo/protocol.ts';
import type {ExchangeView as View} from '../../producer-demo/protocol.ts';
import {ExchangeView} from './ExchangeView.tsx';
import {exchangeCall,readPending,storageKey} from './client.ts';
import type {PendingExchange} from './client.ts';

export function ExchangeApp({csrf,persona,canSubmit,canApprove}:{csrf:string;persona:string;canSubmit:boolean;canApprove:boolean}){
  const key=storageKey(persona);
  const [saved]=useState(()=>{try{return{pending:readPending(localStorage,key),error:''};}catch{return{pending:undefined,error:'Saved-request storage is unreadable. Preserve it before continuing; new commands are paused.'};}});
  const [view,setView]=useState<View>(),[pending,setPending]=useState<PendingExchange|undefined>(saved.pending),[busy,setBusy]=useState(false),[error,setError]=useState(''),[storageError,setStorageError]=useState(saved.error);
  const [selected,setSelected]=useState<string>(),[notice,setNotice]=useState('');
  const generation=useRef(0),writing=useRef(false),serial=useRef(0),run=useRef<string|undefined>(undefined);
  function remember(value:View){setView(prior=>prior?.exchange&&value.exchange?.requestId===prior.exchange.requestId&&value.runId===prior.runId
    &&(prior.exchange.job?.sequence??0)>(value.exchange.job?.sequence??0)?{...value,exchange:prior.exchange}:value);}

  useEffect(()=>{
    const current=++generation.current;let timer:ReturnType<typeof setTimeout>;
    async function poll(){const started=serial.current;try{
      const value=await exchangeCall(csrf,'read',{schemaVersion:PRODUCER_VERSION,...(selected?{requestId:selected,...(run.current?{runId:run.current}:{})}:{})});
      if(generation.current!==current||writing.current||started!==serial.current)return;
      if(run.current&&run.current!==value.runId)setNotice('Producer state changed to a different run. Saved commands keep their original run and cannot execute here. Check shared requests before creating a replacement.');
      run.current=value.runId;remember(value);
    }catch(cause){if(generation.current===current&&started===serial.current){if(cause instanceof ProducerError&&cause.code==='RUN_CHANGED'){run.current=undefined;setSelected(undefined);setView(undefined);}setError(cause instanceof Error?cause.message:'UNAVAILABLE');}}
    finally{if(generation.current===current)timer=setTimeout(()=>{void poll();},1200);}}
    void poll();return()=>{generation.current=current+1;clearTimeout(timer);};
  },[csrf,selected]);
  async function execute(request:PendingExchange){
    if(writing.current||storageError)return;writing.current=true;serial.current++;const current=generation.current;setBusy(true);setError('');
    try{
      // Persist before sending; retries always use this exact action and body.
      const saved=readPending(localStorage,key);
      if(saved&&JSON.stringify(saved)!==JSON.stringify(request))throw new Error('Resolve the saved exchange command first.');
      localStorage.setItem(key,JSON.stringify(request));setPending(request);
      const value=await exchangeCall(csrf,request.action,request.input);
      if(JSON.stringify(readPending(localStorage,key))===JSON.stringify(request))localStorage.removeItem(key);
      if(generation.current===current){setPending(undefined);run.current=value.runId;remember(value);setSelected(value.exchange?.requestId);setNotice('Producer reply received.');}
    }catch(cause){if(generation.current===current)setError(cause instanceof Error?cause.message:'UNAVAILABLE');}
    finally{writing.current=false;if(generation.current===current)setBusy(false);}
  }
  function submit(form:HTMLFormElement){try{
    if(pending||!view||!canSubmit)return;
    const fields=new FormData(form),deadline=String(fields.get('deliveryBy')??'');
    const budget=Number(fields.get('budget'));if(!Number.isFinite(budget)||!Number.isSafeInteger(Math.round(budget*100)))throw new Error('Enter a valid USD budget.');
    const brief=briefSchema.parse({need:fields.get('need'),material:fields.get('material'),quantity:Number(fields.get('quantity')),budgetMinor:Math.round(budget*100),stl:'not_provided',scenario:fields.get('scenario'),...(deadline?{deliveryBy:new Date(deadline+'Z').toISOString()}:{})});
    void execute({action:'submit',input:{schemaVersion:PRODUCER_VERSION,runId:view.runId,commandId:crypto.randomUUID(),brief}});
  }catch{setError('Check the brief, quantity, budget and optional UTC deadline.');}}
  function approve(){const e=view?.exchange;if(!e||!canApprove||pending)return;void execute({action:'accept',input:{schemaVersion:PRODUCER_VERSION,runId:e.runId,commandId:crypto.randomUUID(),requestId:e.requestId,quoteId:e.quote.quoteId,quoteRevision:e.quote.revision,termsDigest:e.quote.termsDigest}});}
  return <div className="producer-exchange"><h2>Request a quote</h2><p>Describe the part. Review the quote before approving.</p>
    {(error||storageError)&&<p role="alert">{storageError||error}{error==='UNAVAILABLE'?' · The outcome may be unknown. Retry the saved command unchanged.':''}</p>}
    {notice&&<p role="status">{notice}</p>}
    {pending&&<aside className="exchange-pending"><h2>Saved {pending.action} command</h2><p>Keep this exact command when a response is uncertain. A retry in the retained run returns the original receipt and cannot create a second job. A different run rejects the saved command.</p><button type="button" disabled={busy||Boolean(storageError)} onClick={()=>{void execute(pending);}}>Retry saved command</button><button type="button" disabled={busy} onClick={()=>{try{localStorage.removeItem(key);setPending(undefined);setError('');setNotice('Saved intent discarded explicitly. Check shared requests for an earlier result before sending another.');}catch{setStorageError('Saved-request storage cannot be changed.');}}}>Discard saved intent</button></aside>}
    <details className="exchange-compose" open={!view?.exchange}><summary>New request</summary><form className="exchange-form" onSubmit={event=>{event.preventDefault();submit(event.currentTarget);}}><h3>Part requirements</h3>
      <label>What part do you need?<textarea name="need" required minLength={3} maxLength={1000} defaultValue="A small bracket for a desk organizer"/></label>
      <label>Material requirement<input name="material" required maxLength={100} defaultValue="PLA requested; compatibility unverified"/></label>
      <label>Counted parts<input name="quantity" type="number" min="1" max="20" step="1" required defaultValue="1"/></label>
      <label>Stated budget (USD, synthetic)<input name="budget" type="number" min="0" max="1000000" step="0.01" required defaultValue="30"/></label>
      <label>Optional delivery deadline (UTC)<input name="deliveryBy" type="datetime-local"/></label>
      <label>Simulated outcome<select name="scenario" aria-label="Simulated outcome" defaultValue="normal"><option value="normal">Normal simulated completion</option><option value="fail_after_start">Simulated producer failure after starting</option></select></label>
      <p>No STL supplied. Quotes remain conditional; this flow does not upload or inspect geometry.</p>
      <button disabled={busy||Boolean(pending)||!view||!canSubmit||Boolean(storageError)}>Send brief to producer</button>
      {!canSubmit&&<p>This participant cannot submit a buyer request.</p>}
    </form></details>
    <ExchangeView view={view} busy={busy} pending={Boolean(pending)||Boolean(storageError)} canApprove={canApprove} onApprove={approve} onSelect={id=>{setSelected(id);setError('');}}/>
  </div>;
}
