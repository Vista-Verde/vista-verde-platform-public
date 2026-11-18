import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { localPool,PostgresRepository } from '../../packages/db/src/postgres.ts';
import { fixtureTokens,businessSnapshot } from '../../packages/db/src/local-operations.ts';
import { Application } from '../../packages/domain/src/index.ts';
import { draft,publication,purchase } from '../../packages/db/src/fixtures.ts';
import { bootstrapWorkOrderStore } from '../../apps/local/src/work-store.ts';
import { LEGACY_DATABASE,WORK_DATABASE,workOrderDemoEnabled } from '../../apps/local/src/config.ts';
import { workOrderInput,responseInput,confirmationInput,reportInput,acknowledgementInput,recordId } from './market-helpers.ts';
import { ok } from './helpers.ts';

type LegacyModule={bootstrapLocal:(pool:pg.Pool,key:string)=>Promise<void>;businessSnapshot:(client:pg.PoolClient)=>Promise<{checksum:string;counts:Record<string,number>}>};
async function isolatedStores(t:TestContext){
  const root=process.env.VV_TEST_DATABASE_URL;assert.ok(root,'Use the owned disposable PostgreSQL runner');const url=new URL(root);assert.equal(url.pathname,'/postgres');assert.equal(url.username,'postgres');
  const admin=localPool(root),key=randomBytes(32).toString('hex'),oldURL=new URL(root),workURL=new URL(root);oldURL.pathname='/'+LEGACY_DATABASE;workURL.pathname='/'+WORK_DATABASE;
  const old=localPool(oldURL.toString()),work=localPool(workURL.toString());const names=await admin.query('SELECT datname FROM pg_database WHERE datname=ANY($1::text[])',[[LEGACY_DATABASE,WORK_DATABASE]]);
  assert.equal(names.rowCount,0,'Both fixed names must be absent before this test owns them');
  t.after(async()=>{await work.end();await old.end();await admin.query('DROP DATABASE IF EXISTS vista_verde_work_orders');await admin.query('DROP DATABASE IF EXISTS vista_verde_local');await admin.end();});
  await admin.query('CREATE DATABASE vista_verde_local');
  const path=new URL('../../legacy-dist/packages/db/src/local-operations.js',import.meta.url).href;
  const legacy=await import(path) as LegacyModule;await legacy.bootstrapLocal(old,key);
  // The frozen seed helper does not create the cluster-wide runtime role; its
  // bootstrap CLI does. Model that pre-existing limited role in this owned PG.
  if (!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname='vista_verde_app'")).rowCount)
    await admin.query(`CREATE ROLE vista_verde_app LOGIN PASSWORD '${randomBytes(32).toString('hex')}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
  const oldState=async()=>{const client=await old.connect();try{return{business:await legacy.businessSnapshot(client),grants:(await client.query('SELECT to_jsonb(g) AS record FROM grants g ORDER BY id')).rows,
    bootstrap:(await client.query('SELECT to_jsonb(s) AS record FROM local_operation_state s')).rows};}finally{client.release();}};
  const workState=async()=>{const client=await work.connect();try{return{business:await businessSnapshot(client),grants:(await client.query('SELECT to_jsonb(g) AS record FROM grants g ORDER BY id')).rows,
    bootstrap:(await client.query('SELECT to_jsonb(s) AS record FROM local_operation_state s')).rows};}finally{client.release();}};
  return{admin,old,work,key,legacy,oldState,workState};
}

test('isolated owner store: fixed work-order enablement refuses unrecognized values or arbitrary database selection',()=>{
  assert.equal(LEGACY_DATABASE,'vista_verde_local');assert.equal(WORK_DATABASE,'vista_verde_work_orders');
  assert.equal(workOrderDemoEnabled({}),false);assert.equal(workOrderDemoEnabled({VV_WORK_ORDER_DEMO_ENABLED:'false'}),false);assert.equal(workOrderDemoEnabled({VV_WORK_ORDER_DEMO_ENABLED:'true'}),true);
  for(const value of ['yes','1','TRUE','vista_verde_local','vista_verde_work_orders'])assert.throws(()=>workOrderDemoEnabled({VV_WORK_ORDER_DEMO_ENABLED:value}),/Invalid isolated demo enablement/);
});

test('isolated owner store: bootstrap creates only the new empty database, preserves canonical legacy records/grants, and restart verifies without reseeding either store',async t=>{
  const {admin,old,work,key,legacy,oldState,workState}=await isolatedStores(t),tokens=fixtureTokens(key);
  const original=new Application(new PostgresRepository(old)),oldRepository=new PostgresRepository(old);
  const buyer=await oldRepository.authenticate(tokens.buyer!),agent=await oldRepository.authenticate(tokens['buyer-agent']!),producer=await oldRepository.authenticate(tokens['producer-a']!);
  const created=ok(await original.execute('createRequirementDraft',draft('canonical-before-new-store'),agent)),requirementId=created.recordIds.requirementId!;
  ok(await original.execute('publishRequirement',publication(requirementId,'canonical-original-slot',6000,new Date(Date.now()+86400000).toISOString()),buyer));
  const originalReceipt=ok(await original.execute('purchaseSlot',purchase('canonical-original-slot'),producer));
  await old.query("UPDATE grants SET revoked=true,used_minor=4321 WHERE actor_id='buyer-second'");const before=await oldState();
  assert.equal((await old.query("SELECT to_regclass('public.market_schema') AS marker")).rows[0].marker,null);
  await bootstrapWorkOrderStore(admin,key);assert.deepEqual(await oldState(),before);
  const target=new Application(new PostgresRepository(work)),repository=new PostgresRepository(work),workBuyer=await repository.authenticate(tokens.buyer!),workProducer=await repository.authenticate(tokens['producer-a']!);
  const posted=ok(await target.execute('postWorkOrder',workOrderInput('isolated-owner-concrete-work'),workBuyer)),workOrderId=recordId(posted,'workOrderId');
  const proposed=ok(await target.execute('respondToWorkOrder',responseInput('isolated-owner-private-capacity',workOrderId),workProducer)),proposalId=recordId(proposed,'proposalId');
  ok(await target.execute('confirmMarketProposal',confirmationInput('isolated-owner-buyer-approval',proposalId,1),workBuyer));
  const commitmentId=recordId(ok(await target.execute('confirmMarketProposal',confirmationInput('isolated-owner-producer-approval',proposalId,2),workProducer)),'commitmentId');
  const reported=ok(await target.execute('reportMarketFulfillment',reportInput('isolated-owner-five-reported',commitmentId,1,5),workProducer));
  ok(await target.execute('acknowledgeMarketFulfillment',acknowledgementInput('isolated-owner-five-ack',recordId(reported,'fulfillmentId')),workBuyer));
  await work.query("UPDATE grants SET revoked=true,used_minor=8765 WHERE actor_id='buyer-second'");const targetBefore=await workState();
  await bootstrapWorkOrderStore(admin,key);await bootstrapWorkOrderStore(admin,key);
  assert.deepEqual(await workState(),targetBefore,'Restart retains IDs, partial fulfillment, consumed budgets and changed grant authority');assert.deepEqual(await oldState(),before);
  assert.equal((await old.query('SELECT count(*) FROM requirements WHERE id=$1',[requirementId])).rows[0].count,'1');
  assert.equal((await work.query('SELECT count(*) FROM requirements WHERE id=$1',[requirementId])).rows[0].count,'0','Original canonical work is never imported into the demo');
  assert.deepEqual(await original.execute('purchaseSlot',purchase('canonical-original-slot'),producer),originalReceipt);
  await legacy.bootstrapLocal(old,key);assert.deepEqual(await oldState(),before,'The retained legacy bootstrap remains usable and unchanged');
  await assert.rejects(()=>bootstrapWorkOrderStore(admin,randomBytes(32).toString('hex')),/binding mismatch/);assert.deepEqual(await oldState(),before);assert.deepEqual(await workState(),targetBefore);
});

test('isolated owner store: foreign maintenance targets and nonempty incompatible fixed targets fail without altering the original database',async t=>{
  const {admin,old,work,key,oldState}=await isolatedStores(t),before=await oldState();
  await assert.rejects(()=>bootstrapWorkOrderStore(old,key),/fixed maintenance database/);assert.deepEqual(await oldState(),before);
  await admin.query('CREATE DATABASE vista_verde_work_orders');await work.query('CREATE TABLE preserve_incompatible_target(marker text PRIMARY KEY)');await work.query("INSERT INTO preserve_incompatible_target VALUES('do-not-overwrite')");
  await assert.rejects(()=>bootstrapWorkOrderStore(admin,key),/approved local schema|not empty/);
  assert.deepEqual((await work.query('SELECT marker FROM preserve_incompatible_target')).rows,[{marker:'do-not-overwrite'}]);
  assert.equal((await work.query("SELECT to_regclass('public.market_schema') AS marker")).rows[0].marker,null);assert.deepEqual(await oldState(),before);
  await work.query('DROP TABLE preserve_incompatible_target');await work.query('CREATE SCHEMA pgaudit');
  await work.query('CREATE TABLE pgaudit.foreign_marker(marker text PRIMARY KEY)');await work.query("INSERT INTO pgaudit.foreign_marker VALUES('preserve-foreign-schema')");
  await assert.rejects(()=>bootstrapWorkOrderStore(admin,key),/unexpected schema|not empty/);
  assert.deepEqual((await work.query('SELECT marker FROM pgaudit.foreign_marker')).rows,[{marker:'preserve-foreign-schema'}]);
  assert.equal((await work.query("SELECT to_regclass('public.market_schema') AS marker")).rows[0].marker,null);assert.deepEqual(await oldState(),before);
});
