import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { localPool,PostgresRepository } from '../../packages/db/src/postgres.ts';
import { Application } from '../../packages/domain/src/index.ts';
import { draft,publication,purchase } from '../../packages/db/src/fixtures.ts';
import { fixture,ok,failure } from './helpers.ts';

test('local-only database guard rejects driver host overrides, fragments and other schemes without connecting',() => {
  for (const target of [
    'postgresql://fixture:fake@127.0.0.1:5432/test?host=example.invalid',
    'postgresql://127.0.0.1/test?host=/tmp/foreign-socket',
    'postgresql://127.0.0.1/test?sslmode=require','postgresql://127.0.0.1/test#options',
    'http://127.0.0.1/test','postgresql://example.invalid/test'
  ]) assert.throws(() => localPool(target),/loopback-local/);
  assert.throws(() => localPool('not a URL'),/Invalid foundation database target/);
});

test('ineligible producers get one private-object denial before slot state, revisions or account contention',async t => {
  const f=await fixture(t); await f.publish('available'); await f.publish('withdrawn'); await f.publish('purchased');
  ok(await f.application.execute('withdrawUnpurchasedSlot',{ ...purchase('withdrawn'),reason: 'review fixture' },f.context('buyer')));
  ok(await f.application.execute('purchaseSlot',purchase('purchased'),f.context('producer-a')));
  await f.pool.query("UPDATE capabilities SET evidence_status='self_declared' WHERE organization_id='producer-b-org'");
  const before=await f.snapshot(); const holder=await f.pool.connect();
  try {
    await holder.query('BEGIN'); await holder.query("SELECT id FROM accounts WHERE id='buyer-funds' FOR UPDATE");
    for (const slot of ['unknown','available','withdrawn','purchased']) for (const version of [1,999]) {
      failure(await f.application.execute('purchaseSlot',{ ...purchase(slot,`${slot}-${version}`),
        expectedRecordVersion: version,termsRevision: version },f.context('producer-b')),'FORBIDDEN');
    }
    await holder.query('ROLLBACK');
  } finally { holder.release(); }
  assert.deepEqual(await f.snapshot(),before); await f.reconcile();
});

test('eligibility lock waits cannot authorize purchase after slot or grant expiry',async t => {
  for (const kind of ['slot','grant'] as const) {
    const f=await fixture(t); const boundary=new Date(Date.now()+1400).toISOString();
    await f.publish(kind,6000,'housing-panel',kind === 'slot' ? boundary : undefined);
    if (kind === 'grant') await f.pool.query('UPDATE grants SET expires_at=$1 WHERE id=$2',[boundary,f.context('producer-a').grantId]);
    const holder=await f.pool.connect(); const before=await f.snapshot(); let pending: ReturnType<typeof f.application.execute> | undefined;
    try {
      await holder.query('BEGIN'); await holder.query('LOCK TABLE capabilities IN ACCESS EXCLUSIVE MODE');
      await setTimeout(Math.max(0,Date.parse(boundary)-Date.now()-140));
      pending=f.application.execute('purchaseSlot',purchase(kind),f.context('producer-a'));
      let blocked=false;
      for (let i=0;i<10;i++) {
        const waiting=await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM capabilities%'");
        if (waiting.rowCount) { blocked=true; break; } await setTimeout(5);
      }
      assert.equal(blocked,true,'Purchase must encounter the controlled eligibility wait.');
      await setTimeout(Math.max(0,Date.parse(boundary)-Date.now()+25)); await holder.query('ROLLBACK');
      failure(await pending,kind === 'slot' ? 'SLOT_EXPIRED' : 'FORBIDDEN');
    } finally { await holder.query('ROLLBACK'); holder.release(); if (pending) await pending; }
    assert.deepEqual(await f.snapshot(),before); await f.reconcile();
  }
});

test('owning-organization read visibility does not bypass producer capability during purchase',async t => {
  const f=await fixture(t); await f.publish('own-org');
  await f.pool.query("UPDATE memberships SET organization_id='buyer-org' WHERE actor_id='producer-a'");
  await f.pool.query("UPDATE accounts SET organization_id='buyer-org' WHERE id='producer-a-funds'");
  const current=await f.repository.authenticate(f.token('producer-a')); const before=await f.snapshot();
  failure(await f.application.execute('purchaseSlot',purchase('own-org'),current),'FORBIDDEN');
  assert.deepEqual(await f.snapshot(),before); await f.reconcile();
});

test('publication rechecks expiry after delayed released-term validation and rolls back all slots/holds',async t => {
  const f=await fixture(t); const created=ok(await f.application.execute('createRequirementDraft',draft('review-publication'),f.context('buyer-agent')));
  const boundary=new Date(Date.now()+900).toISOString(); const input=publication(created.recordIds.requirementId!,'late-publication',6000,boundary);
  const holder=await f.pool.connect(); const before=await f.snapshot(); let pending: ReturnType<typeof f.application.execute> | undefined;
  try {
    await holder.query('BEGIN'); await holder.query('LOCK TABLE fixture_terms IN ACCESS EXCLUSIVE MODE');
    await setTimeout(Math.max(0,Date.parse(boundary)-Date.now()-140)); pending=f.application.execute('publishRequirement',input,f.context('buyer'));
    let blocked=false;
    for (let i=0;i<10;i++) {
      const waiting=await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM fixture_terms%'");
      if (waiting.rowCount) { blocked=true; break; } await setTimeout(5);
    }
    assert.equal(blocked,true); await setTimeout(Math.max(0,Date.parse(boundary)-Date.now()+25)); await holder.query('ROLLBACK');
    failure(await pending,'SLOT_EXPIRED');
  } finally { await holder.query('ROLLBACK'); holder.release(); if (pending) await pending; }
  assert.deepEqual(await f.snapshot(),before); await f.reconcile();
});

test('purchase versus processed expiry has one closed uncharged outcome across independent connections',async t => {
  const f=await fixture(t); const poolA=localPool(f.connectionString),poolB=localPool(f.connectionString);
  f.cleanupWith(() => poolA.end()); f.cleanupWith(() => poolB.end());
  const a=new Application(new PostgresRepository(poolA)),b=new Application(new PostgresRepository(poolB));
  const pids=await Promise.all([poolA.query('SELECT pg_backend_pid() AS pid'),poolB.query('SELECT pg_backend_pid() AS pid')]);
  assert.notEqual(pids[0]!.rows[0].pid,pids[1]!.rows[0].pid);
  for (let i=0;i<5;i++) {
    const slot=`expiry-race-${i}`,boundary=new Date(Date.now()+300).toISOString(); await f.publish(slot,6000,'housing-panel',boundary);
    await setTimeout(Math.max(0,Date.parse(boundary)-Date.now()+10));
    let start!: () => void; const barrier=new Promise<void>(resolve => { start=resolve; });
    const buying=(async () => { await barrier; return a.execute('purchaseSlot',purchase(slot),f.context('producer-a')); })();
    const expiring=(async () => { await barrier; return b.execute('processExpiredSlot',purchase(slot),f.context('buyer')); })();
    start(); const results=await Promise.all([buying,expiring]); assert.equal(results.filter(receipt => receipt.ok).length,1);
    assert.equal(results[0]!.ok,false); if (!results[0]!.ok) assert.ok(['SLOT_EXPIRED','SLOT_UNAVAILABLE'].includes(results[0]!.code));
    const released=ok(results[1]!); assert.equal(released.state,'expired');
    assert.deepEqual(await f.application.execute('processExpiredSlot',purchase(slot),f.context('buyer')),released); await f.reconcile();
  }
  assert.equal((await f.pool.query('SELECT count(*) AS n FROM commitments')).rows[0].n,'0');
  assert.equal((await f.pool.query("SELECT balance FROM accounts WHERE id='slot-price-suspense'")).rows[0].balance,'0');
});

test('available-slot projection remains coherent through concurrent purchase and paginates eligible released specifications',async t => {
  const f=await fixture(t); const housing=await f.publish('a'); await f.publish('b'); await f.publish('c',6000,'robotics-frame');
  const readerPool=localPool(f.connectionString); f.cleanupWith(() => readerPool.end()); const client=await readerPool.connect();
  const query=client.query.bind(client); let selected!: () => void,proceed!: () => void;
  const ready=new Promise<void>(resolve => { selected=resolve; }),barrier=new Promise<void>(resolve => { proceed=resolve; });
  t.mock.method(client,'query',(async (sql: string,values?: unknown[]) => {
    const rows=await query(sql,values);
    if (sql.includes('FROM slots s') && sql.includes("s.state='available'")) { selected(); await barrier; }
    return rows;
  }) as typeof client.query);
  t.mock.method(readerPool,'connect',async () => client);
  const reader=new Application(new PostgresRepository(readerPool));
  const listing=reader.execute('listAvailableSlots',{ limit: 1 },f.context('producer-a'));
  try {
    await ready; const bought=ok(await f.application.execute('purchaseSlot',purchase('a'),f.context('producer-b')));
    assert.equal(bought.recordIds.specificationId,'housing-panel'); assert.equal(bought.recordIds.termsId,'synthetic-v1');
  } finally { proceed(); }
  const first=ok(await listing); const slots=first.data.slots as { slotId: string; state: string; releasedSpecification: { criteria: { process: string } } }[];
  assert.equal(slots.length,1); assert.equal(slots[0]!.slotId,'a'); assert.equal(slots[0]!.state,'available');
  assert.equal(slots[0]!.releasedSpecification.criteria.process,'panel_cut'); assert.equal(first.data.nextCursor,'a');
  const second=ok(await f.application.execute('listAvailableSlots',{ limit: 1,cursor: 'a' },f.context('producer-a')));
  assert.equal((second.data.slots as { slotId: string }[])[0]!.slotId,'b'); assert.equal(second.data.nextCursor,'b');
  const third=ok(await f.application.execute('listAvailableSlots',{ limit: 1,cursor: 'b' },f.context('producer-a')));
  assert.equal((third.data.slots as { slotId: string }[])[0]!.slotId,'c'); assert.equal(third.data.nextCursor,null);
  const fresh=ok(await f.application.execute('getRequirement',{ requirementId: housing.requirementId },f.context('buyer')));
  assert.equal((fresh.data.slots as { state: string }[])[0]!.state,'purchased');
  await f.pool.query("UPDATE capabilities SET evidence_status='self_declared' WHERE organization_id='producer-a-org'");
  const denied=ok(await f.application.execute('listAvailableSlots',{},f.context('producer-a'))); assert.deepEqual(denied.data.slots,[]);
  await f.reconcile();
});

test('out-of-range audit cursors are validation failures with no DB effects',async t => {
  const f=await fixture(t); const { requirementId }=await f.publish('cursor'); const before=await f.snapshot();
  for (const cursor of ['9'.repeat(100),'9223372036854775808','-1','00','foreign'])
    failure(await f.application.execute('getScopedAudit',{ requirementId,cursor },f.context('buyer')),'VALIDATION_FAILED');
  assert.deepEqual(await f.snapshot(),before);
});
