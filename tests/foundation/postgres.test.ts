import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { localPool,PostgresRepository,migrate } from '../../packages/db/src/postgres.ts';
import { Application } from '../../packages/domain/src/index.ts';
import { draft,publication,purchase } from '../../packages/db/src/fixtures.ts';
import { fixture,ok,failure } from './helpers.ts';

test('PostgreSQL publication holds across requirements and generic robotics; shortfall is atomic',async t => {
  const f = await fixture(t); await f.pool.query("UPDATE accounts SET balance=6000 WHERE id='buyer-funds'");
  const first = await f.publish('housing-last');
  const second = ok(await f.application.execute('createRequirementDraft',draft('robotics','robotics-frame'),f.context('buyer-agent')));
  const pub = publication(second.recordIds.requirementId!,'robotics-last'); pub.slots[0]!.specificationId='robotics-frame';
  const before = await f.snapshot(); failure(await f.application.execute('publishRequirement',pub,f.context('buyer')),'INSUFFICIENT_FUNDS');
  assert.deepEqual(await f.snapshot(),before);
  ok(await f.application.execute('withdrawUnpurchasedSlot',{ ...purchase('housing-last'),reason: 'Fixture withdrawal' },f.context('buyer')));
  ok(await f.application.execute('publishRequirement',pub,f.context('buyer')));
  assert.equal((await f.pool.query('SELECT state FROM requirements WHERE id=$1',[first.requirementId])).rows[0].state,'published');
  await f.reconcile();
});

test('25 independent PostgreSQL connection races yield exactly one commitment/charge per last slot', { timeout: 60000 },async t => {
  const f = await fixture(t); const poolA=localPool(f.connectionString),poolB=localPool(f.connectionString);
  try {
    const pids = await Promise.all([poolA.query('SELECT pg_backend_pid() AS pid'),poolB.query('SELECT pg_backend_pid() AS pid')]);
    assert.notEqual(pids[0]!.rows[0].pid,pids[1]!.rows[0].pid);
    const a = new Application(new PostgresRepository(poolA)),b = new Application(new PostgresRepository(poolB));
    for (let i=0; i<25; i++) {
      const slot=`last-${i}`; await f.publish(slot);
      let start!: () => void; const barrier=new Promise<void>(resolve => { start=resolve; });
      const commands=[(async () => { await barrier; return a.execute('purchaseSlot',purchase(slot,`same-${i}`),f.context('producer-a')); })(),
        (async () => { await barrier; return b.execute('purchaseSlot',purchase(slot,`same-${i}`),f.context('producer-b')); })()];
      start(); const receipts=await Promise.all(commands); assert.equal(receipts.filter(r => r.ok).length,1);
      failure(receipts.find(r => !r.ok)!,'SLOT_UNAVAILABLE'); const saved=ok(receipts.find(r => r.ok)!);
      const c=(await f.pool.query('SELECT actor_id FROM commitments WHERE id=$1',[saved.recordIds.commitmentId])).rows[0];
      const before=await f.snapshot(); assert.deepEqual(await f.application.execute('purchaseSlot',purchase(slot,`same-${i}`),f.context(c.actor_id)),saved);
      assert.deepEqual(await f.snapshot(),before); await f.reconcile();
    }
    assert.equal((await f.pool.query('SELECT count(*) AS n FROM commitments')).rows[0].n,'25');
    const accounts=(await f.pool.query("SELECT balance,reserved FROM accounts WHERE id='buyer-funds'")).rows[0]; assert.equal(accounts.reserved,'150000');
    assert.equal((await f.pool.query("SELECT balance FROM accounts WHERE id='slot-price-suspense'")).rows[0].balance,'2500');
  } finally { await poolA.end(); await poolB.end(); }
});

test('two grants publishing competing requirements share the account lock and cannot advertise the same funds',async t => {
  const f=await fixture(t); await f.pool.query("UPDATE accounts SET balance=9000 WHERE id='buyer-funds'");
  const r1=ok(await f.application.execute('createRequirementDraft',draft('one'),f.context('buyer-agent')));
  const r2=ok(await f.application.execute('createRequirementDraft',draft('two'),f.context('buyer-agent')));
  const receipts=await Promise.all([
    f.application.execute('publishRequirement',publication(r1.recordIds.requirementId!,'one'),f.context('buyer')),
    f.application.execute('publishRequirement',publication(r2.recordIds.requirementId!,'two'),f.context('buyer-second'))]);
  assert.equal(receipts.filter(r => r.ok).length,1); failure(receipts.find(r => !r.ok)!,'INSUFFICIENT_FUNDS');
  assert.equal((await f.pool.query('SELECT count(*) AS n FROM slots')).rows[0].n,'1'); await f.reconcile();
});

test('same-key concurrent purchase returns one historical result; fingerprint conflict and new key do not charge twice',async t => {
  const f=await fixture(t); await f.pool.query("UPDATE accounts SET balance=6000 WHERE id='buyer-funds'"); await f.publish('last');
  const receipts=await Promise.all([f.application.execute('purchaseSlot',purchase('last'),f.context('producer-a')),
    f.application.execute('purchaseSlot',purchase('last'),f.context('producer-a'))]);
  assert.deepEqual(ok(receipts[0]!),ok(receipts[1]!)); const before=await f.snapshot();
  failure(await f.application.execute('purchaseSlot',{ ...purchase('last'),termsRevision: 2 },f.context('producer-a')),'IDEMPOTENCY_CONFLICT');
  failure(await f.application.execute('purchaseSlot',purchase('last','another'),f.context('producer-a')),'SLOT_UNAVAILABLE');
  assert.deepEqual(await f.snapshot(),before); await f.reconcile();
  assert.equal((await f.pool.query("SELECT reserved FROM accounts WHERE id='buyer-funds'")).rows[0].reserved,'6000');
});

test('purchase versus withdrawal has one consistent outcome; purchased holds cannot be reclaimed',async t => {
  const f=await fixture(t); await f.publish('last');
  const receipts=await Promise.all([
    f.application.execute('purchaseSlot',purchase('last'),f.context('producer-a')),
    f.application.execute('withdrawUnpurchasedSlot',{ ...purchase('last'),reason: 'withdraw fixture' },f.context('buyer'))]);
  assert.equal(receipts.filter(r => r.ok).length,1);
  const state=(await f.pool.query('SELECT state FROM slots')).rows[0].state;
  if (state === 'purchased') { failure(receipts[1]!,'COMMITMENT_DISPOSITION_REQUIRED'); assert.equal((await f.pool.query('SELECT state FROM holds')).rows[0].state,'committed'); }
  else { assert.equal(state,'withdrawn'); failure(receipts[0]!,'SLOT_UNAVAILABLE'); assert.equal((await f.pool.query('SELECT state FROM holds')).rows[0].state,'released'); }
  await f.reconcile();
});

test('expiry checks fresh database time after account lock wait; delayed cleanup retains the hold',async t => {
  const f=await fixture(t); const expiration=new Date(Date.now()+1500).toISOString(); await f.publish('expiring',6000,'housing-panel',expiration);
  const holder=await f.pool.connect();
  try {
    await holder.query('BEGIN'); await holder.query("SELECT id FROM accounts WHERE id='buyer-funds' FOR UPDATE");
    // Release within each 250ms lock budget, but after the expiry instant.
    await setTimeout(Math.max(0,Date.parse(expiration)-Date.now()-100));
    const pending=f.application.execute('purchaseSlot',purchase('expiring'),f.context('producer-a'));
    await setTimeout(150); await holder.query('ROLLBACK'); failure(await pending,'SLOT_EXPIRED');
  } finally { holder.release(); }
  assert.equal((await f.pool.query('SELECT state FROM holds')).rows[0].state,'held');
  const expired={ ...purchase('expiring'),idempotencyKey: 'expiry' };
  const receipt=ok(await f.application.execute('processExpiredSlot',expired,f.context('buyer')));
  assert.deepEqual(await f.application.execute('processExpiredSlot',expired,f.context('buyer')),receipt);
  assert.equal((await f.pool.query("SELECT reserved FROM accounts WHERE id='buyer-funds'")).rows[0].reserved,'0'); await f.reconcile();
});

test('saved success after expiry survives process restart and lost response after commit',async t => {
  const f=await fixture(t); await f.publish('last',6000,'housing-panel',new Date(Date.now()+700).toISOString());
  const child=fork(new URL('./crash-client.ts',import.meta.url),[],{ env: { ...process.env,VV_DATABASE_URL: f.connectionString },stdio: ['ignore','ignore','pipe','ipc'] });
  const exit=once(child,'exit'); child.send({ context: f.context('producer-a'),operation: 'purchaseSlot',input: purchase('last') });
  assert.equal((await exit)[0],9); await setTimeout(750);
  const restartedPool=localPool(f.connectionString);
  try {
    const restarted=new Application(new PostgresRepository(restartedPool)); const receipt=ok(await restarted.execute('purchaseSlot',purchase('last'),f.context('producer-a')));
    assert.equal((await f.pool.query('SELECT count(*) AS n FROM commitments')).rows[0].n,'1');
    const before=await f.snapshot(); assert.deepEqual(await restarted.execute('purchaseSlot',purchase('last'),f.context('producer-a')),receipt);
    failure(await restarted.execute('processExpiredSlot',{ ...purchase('last'),idempotencyKey: 'expire' },f.context('buyer')),'COMMITMENT_DISPOSITION_REQUIRED');
    assert.deepEqual(await f.snapshot(),before); await f.reconcile();
  } finally { await restartedPool.end(); }
});

test('current authority, object scope and budgets apply before successful replay',async t => {
  const f=await fixture(t); const { requirementId }=await f.publish('last'); ok(await f.application.execute('purchaseSlot',purchase('last'),f.context('producer-a')));
  const grant=f.context('producer-a').grantId;
  for (const [sql,values] of [
    ['UPDATE grants SET revoked=true WHERE id=$1',[grant]],
    ["UPDATE grants SET revoked=false,expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[grant]],
    ["UPDATE grants SET expires_at=clock_timestamp()+interval '1 hour',requirement_scopes=ARRAY['foreign'] WHERE id=$1",[grant]],
    ["UPDATE grants SET requirement_scopes=ARRAY['*'],max_per_command=99 WHERE id=$1",[grant]]
  ] as [string,unknown[]][]) {
    await f.pool.query(sql,values); const before=await f.snapshot();
    failure(await f.application.execute('purchaseSlot',purchase('last'),f.context('producer-a')),'FORBIDDEN'); assert.deepEqual(await f.snapshot(),before);
  }
  await f.pool.query('UPDATE memberships SET active=false WHERE actor_id=$1',['producer-a']);
  failure(await f.application.execute('getRequirement',{ requirementId },f.context('producer-a')),'FORBIDDEN');
});

test('role, organization, eligibility and private audit/commitment denials disclose no foreign result or mutation',async t => {
  const f=await fixture(t); const incomplete=draft('incomplete'); delete incomplete.destination;
  const r=ok(await f.application.execute('createRequirementDraft',incomplete,f.context('buyer-agent')));
  const before=await f.snapshot();
  failure(await f.application.execute('publishRequirement',publication(r.recordIds.requirementId!,'bad'),f.context('buyer')),'VALIDATION_FAILED');
  failure(await f.application.execute('publishRequirement',publication(r.recordIds.requirementId!,'bad'),f.context('buyer-agent')),'FORBIDDEN');
  failure(await f.application.execute('getRequirement',{ requirementId: r.recordIds.requirementId },f.context('other-buyer')),'FORBIDDEN');
  failure(await f.application.execute('getRequirement',{ requirementId: 'unknown' },f.context('other-buyer')),'FORBIDDEN');
  assert.deepEqual(await f.snapshot(),before);
  const published=await f.publish('last');
  await f.pool.query("UPDATE capabilities SET evidence_status='self_declared' WHERE organization_id='producer-b-org'");
  const after=await f.snapshot(); failure(await f.application.execute('purchaseSlot',purchase('last'),f.context('producer-b')),'FORBIDDEN');
  failure(await f.application.execute('purchaseSlot',purchase('last'),{ ...f.context('producer-a'),organizationId: 'buyer-org' }),'FORBIDDEN');
  failure(await f.application.execute('getScopedAudit',{ requirementId: published.requirementId },f.context('other-buyer')),'FORBIDDEN');
  assert.deepEqual(await f.snapshot(),after);
  const receipt=ok(await f.application.execute('purchaseSlot',purchase('last'),f.context('producer-a')));
  failure(await f.application.execute('getCommitment',{ commitmentId: receipt.recordIds.commitmentId },f.context('producer-b')),'FORBIDDEN');
  await f.reconcile();
});

test('line ceilings, compatible units, currencies, stale distinct revisions and producer shortfall reject atomically',async t => {
  const f=await fixture(t); const r=ok(await f.application.execute('createRequirementDraft',draft('draft'),f.context('buyer-agent')));
  for (const change of [
    (p: ReturnType<typeof publication>) => { p.slots[0]!.quantity.value=2; },
    (p: ReturnType<typeof publication>) => { p.slots[0]!.quantity.unit='kg'; },
    (p: ReturnType<typeof publication>) => { p.slots[0]!.compensation.currency='EUR'; },
    (p: ReturnType<typeof publication>) => { p.requirementRevision=2; },
    (p: ReturnType<typeof publication>) => { p.expectedRecordVersion=2; },
    (p: ReturnType<typeof publication>) => { p.slots[0]!.specificationRevision=2; }
  ]) {
    const input=publication(r.recordIds.requirementId!,'test'); change(input); const before=await f.snapshot();
    assert.equal((await f.application.execute('publishRequirement',input,f.context('buyer'))).ok,false); assert.deepEqual(await f.snapshot(),before);
  }
  ok(await f.application.execute('publishRequirement',publication(r.recordIds.requirementId!,'test'),f.context('buyer')));
  for (const field of ['requirementRevision','specificationRevision','termsRevision','expectedRecordVersion'] as const) {
    const before=await f.snapshot(); failure(await f.application.execute('purchaseSlot',{ ...purchase('test'),[field]: 2 },f.context('producer-a')),'REVISION_CONFLICT'); assert.deepEqual(await f.snapshot(),before);
  }
  await f.pool.query("UPDATE accounts SET balance=99 WHERE id='producer-a-funds'"); const before=await f.snapshot();
  failure(await f.application.execute('purchaseSlot',purchase('test'),f.context('producer-a')),'INSUFFICIENT_FUNDS'); assert.deepEqual(await f.snapshot(),before);
});

test('late outbox failures roll back publication, purchase and release; same-key recovery is safe',async t => {
  const f=await fixture(t); const r=ok(await f.application.execute('createRequirementDraft',draft('draft'),f.context('buyer-agent')));
  const inject=async () => { await f.pool.query("CREATE OR REPLACE FUNCTION fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture fault'; END $$"); await f.pool.query('CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fault()'); };
  const remove=async () => { await f.pool.query('DROP TRIGGER fail_outbox ON outbox'); };
  await inject(); let before=await f.snapshot();
  failure(await f.application.execute('publishRequirement',publication(r.recordIds.requirementId!,'last'),f.context('buyer')),'INTERNAL_ERROR'); assert.deepEqual(await f.snapshot(),before);
  await remove(); ok(await f.application.execute('publishRequirement',publication(r.recordIds.requirementId!,'last'),f.context('buyer')));
  await inject(); before=await f.snapshot();
  failure(await f.application.execute('purchaseSlot',purchase('last'),f.context('producer-a')),'INTERNAL_ERROR'); assert.deepEqual(await f.snapshot(),before);
  const withdrawal={ ...purchase('last'),reason: 'test late release failure' };
  failure(await f.application.execute('withdrawUnpurchasedSlot',withdrawal,f.context('buyer')),'INTERNAL_ERROR'); assert.deepEqual(await f.snapshot(),before);
  await remove(); const receipt=ok(await f.application.execute('withdrawUnpurchasedSlot',withdrawal,f.context('buyer')));
  assert.deepEqual(await f.application.execute('withdrawUnpurchasedSlot',withdrawal,f.context('buyer')),receipt); await f.reconcile();
});

test('late draft/expiry faults and cumulative grant budget denials leave no partial success',async t => {
  const f=await fixture(t);
  const inject=async () => {
    await f.pool.query("CREATE OR REPLACE FUNCTION fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture late fault'; END $$");
    await f.pool.query('CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fault()');
  };
  await inject(); const before=await f.snapshot();
  failure(await f.application.execute('createRequirementDraft',draft('late-draft'),f.context('buyer-agent')),'INTERNAL_ERROR'); assert.deepEqual(await f.snapshot(),before);
  await f.pool.query('DROP TRIGGER fail_outbox ON outbox');
  const receipt=ok(await f.application.execute('createRequirementDraft',draft('late-draft'),f.context('buyer-agent')));
  const expiresAt=new Date(Date.now()+500).toISOString();
  ok(await f.application.execute('publishRequirement',publication(receipt.recordIds.requirementId!,'expiry',6000,expiresAt),f.context('buyer')));
  await setTimeout(Math.max(0,Date.parse(expiresAt)-Date.now()+20)); await inject(); const held=await f.snapshot();
  failure(await f.application.execute('processExpiredSlot',purchase('expiry'),f.context('buyer')),'INTERNAL_ERROR'); assert.deepEqual(await f.snapshot(),held);
  await f.pool.query('DROP TRIGGER fail_outbox ON outbox'); ok(await f.application.execute('processExpiredSlot',purchase('expiry'),f.context('buyer')));
  await f.publish('budget'); await f.pool.query('UPDATE grants SET budget_limit=99 WHERE id=$1',[f.context('producer-a').grantId]);
  const unchanged=await f.snapshot(); failure(await f.application.execute('purchaseSlot',purchase('budget'),f.context('producer-a')),'FORBIDDEN'); assert.deepEqual(await f.snapshot(),unchanged);
  await f.pool.query('UPDATE grants SET budget_limit=100 WHERE id=$1',[f.context('producer-a').grantId]);
  const bought=ok(await f.application.execute('purchaseSlot',purchase('budget'),f.context('producer-a')));
  assert.deepEqual(await f.application.execute('purchaseSlot',purchase('budget'),f.context('producer-a')),bought);
  await f.publish('over-budget'); const spent=await f.snapshot();
  failure(await f.application.execute('purchaseSlot',purchase('over-budget'),f.context('producer-a')),'FORBIDDEN'); assert.deepEqual(await f.snapshot(),spent); await f.reconcile();
});

test('PostgreSQL lock timeout exhausts bounded retries with no effects and recovers after unlock',async t => {
  const f=await fixture(t); const { requirementId }=await f.publish('existing');
  const r=ok(await f.application.execute('createRequirementDraft',draft('other'),f.context('buyer-agent')));
  const holder=await f.pool.connect(); const before=await f.snapshot();
  try {
    await holder.query('BEGIN'); await holder.query("SELECT id FROM accounts WHERE id='buyer-funds' FOR UPDATE");
    failure(await f.application.execute('publishRequirement',publication(r.recordIds.requirementId!,'other'),f.context('buyer')),'RETRYABLE_BUSY');
    await holder.query('ROLLBACK'); assert.deepEqual(await f.snapshot(),before);
    ok(await f.application.execute('publishRequirement',publication(r.recordIds.requirementId!,'other'),f.context('buyer')));
  } finally { holder.release(); }
  assert.equal((await f.application.execute('getRequirement',{ requirementId },f.context('buyer'))).ok,true); await f.reconcile();
});

test('database serialization and deadlock SQLSTATE retries preserve one financial effect',async t => {
  const f=await fixture(t); await f.publish('last');
  await f.pool.query('CREATE SEQUENCE fault_attempts');
  await f.pool.query("CREATE FUNCTION retry_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval('fault_attempts')<=2 THEN RAISE EXCEPTION 'serialization fixture' USING ERRCODE='40001'; END IF; RETURN NEW; END $$");
  await f.pool.query('CREATE TRIGGER retry_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION retry_fault()');
  ok(await f.application.execute('purchaseSlot',purchase('last'),f.context('producer-a')));
  assert.equal((await f.pool.query('SELECT last_value FROM fault_attempts')).rows[0].last_value,'3');
  assert.equal((await f.pool.query('SELECT count(*) AS n FROM commitments')).rows[0].n,'1'); await f.reconcile();
  await f.pool.query('DROP TRIGGER retry_outbox ON outbox');
  await f.pool.query('ALTER SEQUENCE fault_attempts RESTART WITH 1');
  await f.pool.query("CREATE OR REPLACE FUNCTION retry_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval('fault_attempts')<=2 THEN RAISE EXCEPTION 'deadlock fixture' USING ERRCODE='40P01'; END IF; RETURN NEW; END $$");
  await f.pool.query('CREATE TRIGGER retry_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION retry_fault()');
  ok(await f.application.execute('createRequirementDraft',draft('deadlock-retry'),f.context('buyer-agent')));
  assert.equal((await f.pool.query('SELECT last_value FROM fault_attempts')).rows[0].last_value,'3'); await f.reconcile();
  await f.pool.query('DROP TRIGGER retry_outbox ON outbox');
  const a=await f.pool.connect(),b=await f.pool.connect();
  try {
    await a.query('BEGIN'); await b.query('BEGIN');
    await a.query("SELECT id FROM accounts WHERE id='producer-a-funds' FOR UPDATE");
    await b.query("SELECT id FROM accounts WHERE id='producer-b-funds' FOR UPDATE");
    const cross=async (client: typeof a,id: string) => {
      try { await client.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[id]); await client.query('COMMIT'); return 'ok'; }
      catch (error) { await client.query('ROLLBACK'); return (error as { code: string }).code; }
    };
    const outcomes=await Promise.all([cross(a,'producer-b-funds'),cross(b,'producer-a-funds')]); assert.deepEqual(outcomes.sort(),['40P01','ok']);
  } finally { a.release(); b.release(); }
});

test('schema refuses destructive migration, duplicate allocation and audit mutation',async t => {
  const f=await fixture(t); await assert.rejects(() => migrate(f.pool),{ code: 'FORBIDDEN' });
  await f.publish('last'); ok(await f.application.execute('purchaseSlot',purchase('last'),f.context('producer-a')));
  await assert.rejects(() => f.pool.query("INSERT INTO commitments SELECT 'duplicate',slot_id,producer_organization,actor_id,receipt,state FROM commitments"),{ code: '23505' });
  await assert.rejects(() => f.pool.query("UPDATE audit_events SET payload='{}'"),/append-only/);
  await assert.rejects(() => f.pool.query('DELETE FROM audit_events'),/append-only/); await f.reconcile();
  for (const sql of [
    'UPDATE slots SET price=price+1','UPDATE requirements SET buyer_account=\'other-buyer-funds\'',
    'UPDATE requirement_lines SET quantity=quantity+1',"UPDATE fixture_terms SET recipient_account='producer-a-funds'",
    "UPDATE commitments SET receipt='{}'","UPDATE holds SET state='released',commitment_id=NULL",
    'DELETE FROM journal_entries','DELETE FROM idempotency'
  ]) await assert.rejects(() => f.pool.query(sql),/immutable|protected/);
});
