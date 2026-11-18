import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PendingStore,createPending } from '../../apps/web/client.ts';
import { draft } from '../../packages/db/src/fixtures.ts';
import { WORK_PROFILE } from '../../apps/local/src/config.ts';
import { workOrderInput } from './market-helpers.ts';

test('work-profile recovery never reads, dispatches, overwrites or clears an original canonical unknown intent',()=>{
  const records=new Map<string,string>(),storage={getItem:(key:string)=>records.get(key)??null,setItem:(key:string,value:string)=>{records.set(key,value);},removeItem:(key:string)=>{records.delete(key);}};
  const legacy=new PendingStore(storage),work=new PendingStore(storage,WORK_PROFILE);
  const original=createPending('buyer-agent','createRequirementDraft',draft('same-recovery-key'),'Original canonical draft','same-recovery-key');legacy.save(original);
  const bytes=records.get('vv.pending.buyer-agent');assert.ok(bytes);assert.equal(work.read('buyer-agent'),undefined);
  const request=createPending('buyer-agent','postWorkOrder',workOrderInput('same-recovery-key'),'Separate synthetic work intent','same-recovery-key');work.save(request);
  assert.deepEqual(work.read('buyer-agent'),{...request,profile:WORK_PROFILE,uncertain:true});assert.equal(records.get('vv.pending.buyer-agent'),bytes);
  work.complete(request);assert.equal(work.read('buyer-agent'),undefined);assert.equal(records.get('vv.pending.buyer-agent'),bytes);
  assert.deepEqual(legacy.read('buyer-agent'),{...original,uncertain:true},'The original runtime can still recover exactly its own intent');
});

test('work-profile recovery rejects foreign commands and missing or wrong profile labels while preserving unknown outcome evidence',()=>{
  const records=new Map<string,string>(),storage={getItem:(key:string)=>records.get(key)??null,setItem:(key:string,value:string)=>{records.set(key,value);},removeItem:(key:string)=>{records.delete(key);}};
  const work=new PendingStore(storage,WORK_PROFILE),key=`vv.pending.${WORK_PROFILE}.buyer-agent`;
  const legacy=createPending('buyer-agent','createRequirementDraft',draft('cross-profile'),'Unknown legacy command','cross-profile');
  assert.throws(()=>work.save(legacy),/different data profile/);assert.equal(records.size,0);
  const request=createPending('buyer-agent','postWorkOrder',workOrderInput('unknown-work'),'Unknown work command','unknown-work');
  for(const invalid of [{...legacy,profile:WORK_PROFILE},{...request},{...request,profile:'retained-original'}, {...request,profile:WORK_PROFILE,persona:'producer-a'}]){
    const bytes=JSON.stringify(invalid);records.set(key,bytes);assert.throws(()=>work.read('buyer-agent'),/unreadable/);assert.equal(records.get(key),bytes,'A rejected unknown intent is retained for recovery');
  }
});
