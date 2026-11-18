import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebClient,PendingStore,createPending,retainPending,usd } from '../../apps/web/client.ts';
import type { Session,Failure } from '../../apps/web/client.ts';
const session: Session = { signedIn:true,csrf:'csrf-a',persona:'producer-a',personas:[] };
const success = { schemaVersion:'foundation.v0.1',ok:true,synthetic:true,state:'audit',recordIds:{},data:{},revisions:{},nextActor:null,nextAction:null };
const memory = () => {
  const values = new Map<string,string>();
  return { values,getItem:(key:string) => values.get(key) ?? null,setItem:(key:string,value:string) => { values.set(key,value); },removeItem:(key:string) => { values.delete(key); } };
};
test('React client coalesces only in-flight bootstrap/reads by captured session, never financial writes',async () => {
  const calls: { path:string;csrf?:string }[] = [];
  let release!: () => void;const waiting = new Promise<void>(resolve => { release = resolve; });
  const client = new WebClient(async (input,init) => {
    calls.push({ path:String(input),csrf:(init?.headers as Record<string,string>)?.['x-csrf-token'] });
    await waiting;return new Response(JSON.stringify(String(input) === '/session' ? session : success),{ status:200 });
  });
  const boot = client.boot();assert.equal(client.boot(),boot);
  const first = client.call(session,'getWorkspace',{});assert.equal(client.call(session,'getWorkspace',{}),first);
  const other = client.call({ ...session,csrf:'csrf-b',persona:'producer-b' },'getWorkspace',{});assert.notEqual(other,first);
  const writes = [client.call(session,'purchaseSlot',{}),client.call(session,'purchaseSlot',{})];assert.notEqual(writes[0],writes[1]);
  assert.equal(calls.length,5);release();await Promise.all([boot,first,other,...writes]);
  await client.call(session,'getWorkspace',{});assert.equal(calls.length,6,'Settled reads are refetched, never an authority cache');
  assert.deepEqual(calls.filter(c => c.path.includes('queries')).map(c => c.csrf),['csrf-a','csrf-b','csrf-a']);
});
test('Saved intent freezes nested terms and survives reload with the exact original key',() => {
  const storage = memory(),store = new PendingStore(storage),input = { slotId:'slot',terms:{ revision:1 } };
  const request = createPending('producer-a','purchaseSlot',input,'Purchase','stable-key');store.save(request);
  input.terms.revision = 2;
  const restored = new PendingStore(storage).read('producer-a')!;
  assert.deepEqual(restored.input,{ slotId:'slot',terms:{ revision:1 },idempotencyKey:'stable-key' });
  assert.equal(restored.uncertain,true);assert.equal(JSON.parse(storage.getItem('vv.pending.producer-a')!).uncertain,undefined);
});
test('A settled write invalidates pre-command reads and late read cleanup cannot remove the fresh request',async () => {
  let reads = 0,releaseOld!:()=>void,releaseFresh!:()=>void;
  const oldHeld = new Promise<void>(resolve => { releaseOld=resolve; }),freshHeld = new Promise<void>(resolve => { releaseFresh=resolve; });
  const client = new WebClient(async input => {
    if (String(input).includes('/commands/')) return new Response(JSON.stringify(success));
    const index = ++reads;await (index===1 ? oldHeld : freshHeld);
    return new Response(JSON.stringify({ ...success,data:{ balance:index===1 ? 100000 : 99900 } }));
  });
  const old = client.call(session,'getWorkspace',{});
  await client.call(session,'purchaseSlot',{});
  const fresh = client.call(session,'getWorkspace',{});
  assert.notEqual(fresh,old);assert.equal(reads,2,'Post-command refresh dispatches a fresh request');
  releaseOld();assert.equal((await old).data.balance,100000);
  assert.equal(client.call(session,'getWorkspace',{}),fresh,'Old cleanup leaves the fresh coalesced request intact');
  releaseFresh();assert.equal((await fresh).data.balance,99900);
});
test('Completion uses original owner/key and cannot erase another persona or newer intent',() => {
  const storage = memory(),store = new PendingStore(storage);
  const a = createPending('producer-a','purchaseSlot',{ slotId:'a' },'A','a'),b = createPending('producer-b','purchaseSlot',{ slotId:'b' },'B','b');
  store.save(a);store.save(b);store.complete(a);assert.equal(store.read('producer-a'),undefined);assert.deepEqual(store.read('producer-b')?.input,b.input);
  store.save(a);const newer = createPending('producer-a','purchaseSlot',{ slotId:'new' },'New','new');store.save(newer);store.complete(a);
  assert.deepEqual(store.read('producer-a')?.input,newer.input);
});
test('Unknown outcomes and denied historical recovery retain intent; deterministic fresh refusals permit a new review',() => {
  const request = createPending('producer-a','purchaseSlot',{},'Purchase','key');
  const error = (code?:string,retryable=false) => Object.assign(new Error(),{ code,retryable }) as Failure;
  for (const failure of [error(),error('INTERNAL_ERROR'),error('RETRYABLE_BUSY',true)]) assert.equal(retainPending(request,failure),true);
  for (const code of ['FORBIDDEN','UNAUTHENTICATED','IDEMPOTENCY_CONFLICT']) {
    assert.equal(retainPending(request,error(code)),false);assert.equal(retainPending({ ...request,uncertain:true },error(code)),true);
  }
  assert.equal(retainPending(request,error('INSUFFICIENT_FUNDS')),false);
});
test('Corrupt/mismatched recovery and storage failure are explicit instead of silently replacing financial intent',() => {
  const storage = memory(),store = new PendingStore(storage);
  for (const text of ['{','{}',JSON.stringify(createPending('producer-b','purchaseSlot',{},'B','b'))]) {
    storage.setItem('vv.pending.producer-a',text);assert.throws(() => store.read('producer-a'));
  }
  const unavailable = new PendingStore({ ...storage,setItem:() => { throw new Error('quota'); } });
  assert.throws(() => unavailable.save(createPending('producer-a','purchaseSlot',{},'A','a')),/quota/);
});
test('USD form conversion preserves decimal cents and rejects ambiguous values',() => {
  assert.equal(usd('0.29'),29);assert.equal(usd('1.2'),120);assert.equal(usd('600.00'),60000);
  for (const value of ['-1','1.234','1e3','1,000','NaN','',null]) assert.throws(() => usd(value));
});
