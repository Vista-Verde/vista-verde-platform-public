import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { SlotService } from '../examples/slots/service.ts';
import { FIXTURE_NOW, seedSyntheticFixture, publication, purchase } from '../examples/slots/fixtures.ts';

const tables = ['accounts', 'requirements', 'slots', 'reservations', 'commitments',
  'journal_entries', 'audit_events', 'outbox', 'idempotency'];
function fixture(t: { after: (callback: () => void) => void }, balance = 10_000) {
  const dir = mkdtempSync(join(tmpdir(), 'vista-verde-slots-'));
  const path = join(dir, 'synthetic.sqlite');
  seedSyntheticFixture(path, balance);
  let now = FIXTURE_NOW;
  const service = new SlotService(path, () => now);
  const db = new DatabaseSync(path);
  t.after(() => { service.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { service, db, path, advance: (ms: number) => { now += ms; },
    snapshot: () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])) };
}
function count(db: DatabaseSync, table: string) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
}
function account(db: DatabaseSync, id = 'buyer-funds') {
  return db.prepare('SELECT balance, reserved FROM accounts WHERE id = ?').get(id)!;
}
function rejects(code: string, command: () => unknown) { assert.throws(command, { code }); }
function reconcile(db: DatabaseSync) {
  for (const a of db.prepare('SELECT * FROM accounts').all()) {
    const held = db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM reservations WHERE buyer_account = ? AND state <> 'released'").get(a.id)!;
    assert.equal(a.reserved, held.n);
    assert.ok(Number(a.reserved) <= Number(a.balance));
  }
  for (const tx of db.prepare('SELECT commitment_id, SUM(amount) AS net FROM journal_entries GROUP BY commitment_id').all()) {
    assert.equal(tx.net, 0);
  }
  assert.equal(count(db, 'audit_events'), count(db, 'outbox'));
  assert.equal(count(db, 'audit_events'), count(db, 'idempotency'));
}
type Job = { operation: 'purchase' | 'publish' | 'release'; actor: string; key: string; input: unknown };
type Outcome = { ok: boolean; code?: string; result?: Record<string, unknown> };
async function race(path: string, jobs: Job[]): Promise<Outcome[]> {
  const gate = new SharedArrayBuffer(4);
  const workers: Worker[] = [];
  let ready = 0;
  try {
    return await Promise.all(jobs.map(job => new Promise<Outcome>((resolve, reject) => {
      const worker = new Worker(new URL('./slot-worker.ts', import.meta.url), { workerData: { path, gate, ...job } });
      workers.push(worker);
      let completed = false;
      worker.on('message', message => {
        if (message.ready) {
          if (++ready === jobs.length) { Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0, jobs.length); }
        } else { completed = true; resolve(message); }
      });
      worker.on('error', reject);
      worker.on('exit', code => { if (!completed) reject(new Error(`worker exited early: ${code}`)); });
    })));
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
}

test('publication reserves all slots; a second requirement cannot reuse the same buyer money', t => {
  const f = fixture(t);
  const input = publication();
  input.slots.push({ ...input.slots[0], id: 'housing-second', compensation: 3_000 });
  f.service.publish('buyer', 'publish-housing', input);
  assert.equal(account(f.db).reserved, 9_000);
  const before = f.snapshot();
  rejects('FUNDING_UNAVAILABLE', () => f.service.publish('buyer', 'publish-robotics', publication('robotics', 2_000)));
  assert.deepEqual(f.snapshot(), before);
  f.service.publish('buyer', 'publish-robotics', publication('robotics', 1_000));
  assert.equal(account(f.db).reserved, 10_000);
  reconcile(f.db);
});

test('insufficient publication funds expose no slots or side effects', t => {
  const f = fixture(t, 5_999); const before = f.snapshot();
  rejects('FUNDING_UNAVAILABLE', () => f.service.publish('buyer', 'publish', publication()));
  assert.deepEqual(f.snapshot(), before);
});

test('publication retries persist across reopen; a changed payload conflicts and a fresh key cannot republish', t => {
  const f = fixture(t); const input = publication();
  const result = f.service.publish('buyer', 'publish', input); const before = f.snapshot();
  const reopened = new SlotService(f.path, () => FIXTURE_NOW);
  try { assert.deepEqual(reopened.publish('buyer', 'publish', input), result); } finally { reopened.close(); }
  rejects('IDEMPOTENCY_CONFLICT', () => f.service.publish('buyer', 'publish', publication('housing', 5_000)));
  rejects('ALREADY_PUBLISHED', () => f.service.publish('buyer', 'fresh-key', input));
  assert.deepEqual(f.snapshot(), before);
});

test('purchase transfers the publication hold, balances slot-price entries, and replays without duplicate effects', t => {
  const f = fixture(t, 6_000);
  f.service.publish('buyer', 'publish', publication());
  const result = f.service.purchase('producer-a', 'buy', purchase());
  assert.equal(account(f.db).balance, 6_000); assert.equal(account(f.db).reserved, 6_000);
  assert.equal(account(f.db, 'producer-a-funds').balance, 900);
  assert.equal(account(f.db, 'slot-price-suspense').balance, 100);
  const hold = f.db.prepare('SELECT * FROM reservations').get()!;
  assert.equal(hold.state, 'committed'); assert.equal(hold.commitment_id, result.commitmentId);
  const before = f.snapshot(); f.advance(60_000);
  const reopened = new SlotService(f.path, () => FIXTURE_NOW + 60_000);
  try { assert.deepEqual(reopened.purchase('producer-a', 'buy', purchase()), result); } finally { reopened.close(); }
  rejects('SLOT_UNAVAILABLE', () => f.service.purchase('producer-a', 'another-key', purchase()));
  rejects('IDEMPOTENCY_CONFLICT', () => f.service.purchase('producer-a', 'buy', { ...purchase(), termsRevision: 2 }));
  assert.deepEqual(f.snapshot(), before); reconcile(f.db);
});

test('two producers racing the final slot yield exactly one success (25 independent-connection races)', { timeout: 30_000 }, async t => {
  const f = fixture(t, 150_000);
  for (let i = 0; i < 25; i++) {
    // Independent requirements are synthetic test fixtures; the service still uses the same contracts.
    const req = `race-${i}`; const slot = `${req}-last`;
    f.db.prepare("INSERT INTO requirements VALUES (?, 'buyer-funds', 1, 1, 1, 'component', 'housing', 'draft')").run(req);
    for (const producer of ['producer-a', 'producer-b']) f.db.prepare('INSERT INTO eligible_producers VALUES (?, ?)').run(req, producer);
    const pub = publication(req); pub.slots[0].price = 1;
    f.service.publish('buyer', `publish-${i}`, pub);
    const outcomes = await race(f.path, ['producer-a', 'producer-b'].map(actor => ({ operation: 'purchase', actor, key: `same-scoped-key-${i}`, input: purchase(slot) })));
    assert.equal(outcomes.filter(o => o.ok).length, 1);
    assert.deepEqual(outcomes.filter(o => !o.ok).map(o => o.code), ['SLOT_UNAVAILABLE']);
    const winner = outcomes.find(o => o.ok)!.result!;
    const before = f.snapshot();
    assert.deepEqual(f.service.purchase(winner.producerId as string, `same-scoped-key-${i}`, purchase(slot)), winner);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM commitments WHERE slot_id = ?').get(slot)!.n, 1);
    reconcile(f.db);
  }
  assert.equal(count(f.db, 'commitments'), 25);
  assert.equal(account(f.db).reserved, 150_000);
  assert.equal(account(f.db, 'slot-price-suspense').balance, 25);
});

test('concurrent publication of two requirements cannot oversubscribe the shared buyer account', { timeout: 10_000 }, async t => {
  const f = fixture(t);
  const outcomes = await race(f.path, ['housing', 'robotics'].map(req => ({ operation: 'publish', actor: 'buyer', key: req, input: publication(req) })));
  assert.equal(outcomes.filter(o => o.ok).length, 1);
  assert.deepEqual(outcomes.filter(o => !o.ok).map(o => o.code), ['FUNDING_UNAVAILABLE']);
  assert.equal(account(f.db).reserved, 6_000); assert.equal(count(f.db, 'slots'), 1); reconcile(f.db);
});

test('concurrent retries of the same purchase return one durable result and one debit', { timeout: 10_000 }, async t => {
  const f = fixture(t); f.service.publish('buyer', 'publish', publication());
  const job: Job = { operation: 'purchase', actor: 'producer-a', key: 'buy', input: purchase() };
  const outcomes = await race(f.path, [job, job]);
  assert.ok(outcomes.every(o => o.ok)); assert.deepEqual(outcomes[0].result, outcomes[1].result);
  assert.equal(count(f.db, 'commitments'), 1); assert.equal(account(f.db, 'producer-a-funds').balance, 900); reconcile(f.db);
});

test('withdrawal releases once, retries safely, and enables another requirement to publish', t => {
  const f = fixture(t); f.service.publish('buyer', 'publish', publication());
  const input = { ...purchase(), reason: 'withdrawn' };
  rejects('INSUFFICIENT_AUTHORITY', () => f.service.release('other-buyer', 'release', input));
  rejects('STALE_REVISION', () => f.service.release('buyer', 'release', { ...input, termsRevision: 2 }));
  const result = f.service.release('buyer', 'release', input); const before = f.snapshot();
  assert.equal(result.released, 6_000);
  assert.deepEqual(f.service.release('buyer', 'release', input), result); assert.deepEqual(f.snapshot(), before);
  assert.equal(f.service.release('buyer', 'new-release-key', input).released, 0);
  assert.equal(account(f.db).reserved, 0);
  rejects('SLOT_UNAVAILABLE', () => f.service.purchase('producer-a', 'buy', purchase()));
  f.service.publish('buyer', 'publish-robotics', publication('robotics')); reconcile(f.db);
});

test('expiry blocks purchase at the boundary and releases only after explicit expiry processing', t => {
  const f = fixture(t); f.service.publish('buyer', 'publish', publication());
  const input = { ...purchase(), reason: 'expired' };
  rejects('NOT_EXPIRED', () => f.service.release('buyer', 'expire', input));
  f.advance(60_000); const before = f.snapshot();
  rejects('SLOT_EXPIRED', () => f.service.purchase('producer-a', 'buy', purchase()));
  assert.deepEqual(f.snapshot(), before); assert.equal(account(f.db).reserved, 6_000);
  f.service.release('buyer', 'expire', input);
  assert.equal(account(f.db).reserved, 0); reconcile(f.db);
});

test('withdrawing one published slot preserves its purchased sibling compensation', t => {
  const f = fixture(t, 6_000); const input = publication('housing', 3_000);
  input.slots.push({ ...input.slots[0], id: 'housing-second' });
  f.service.publish('buyer', 'publish', input);
  f.service.purchase('producer-a', 'buy', purchase());
  f.service.release('buyer', 'withdraw-second', { ...purchase('housing-second'), reason: 'withdrawn' });
  assert.equal(account(f.db).reserved, 3_000);
  assert.equal(f.db.prepare("SELECT state FROM reservations WHERE slot_id = 'housing-last'").get()!.state, 'committed');
  assert.equal(f.db.prepare("SELECT state FROM reservations WHERE slot_id = 'housing-second'").get()!.state, 'released');
  reconcile(f.db);
});

test('purchased compensation remains reserved after expiry or attempted buyer withdrawal', t => {
  const f = fixture(t); f.service.publish('buyer', 'publish', publication());
  f.service.purchase('producer-a', 'buy', purchase()); f.advance(60_000); const before = f.snapshot();
  for (const reason of ['expired', 'withdrawn']) rejects('COMMITMENT_DISPOSITION_REQUIRED', () => f.service.release('buyer', reason, { ...purchase(), reason }));
  assert.deepEqual(f.snapshot(), before); assert.equal(account(f.db).reserved, 6_000);
});

test('purchase racing withdrawal has one valid terminal state and no leaked or double-released hold', { timeout: 10_000 }, async t => {
  const f = fixture(t); f.service.publish('buyer', 'publish', publication());
  const outcomes = await race(f.path, [
    { operation: 'purchase', actor: 'producer-a', key: 'buy', input: purchase() },
    { operation: 'release', actor: 'buyer', key: 'withdraw', input: { ...purchase(), reason: 'withdrawn' } }
  ]);
  assert.equal(outcomes.filter(o => o.ok).length, 1);
  const state = f.db.prepare('SELECT state FROM slots').get()!.state;
  if (state === 'purchased') {
    assert.equal(outcomes[1].code, 'COMMITMENT_DISPOSITION_REQUIRED'); assert.equal(account(f.db).reserved, 6_000);
  } else {
    assert.equal(state, 'withdrawn'); assert.equal(outcomes[0].code, 'SLOT_UNAVAILABLE'); assert.equal(account(f.db).reserved, 0);
  }
  reconcile(f.db);
});

test('wrong roles, organizations, eligibility, stale revisions and forged funding fields fail without effects', t => {
  const f = fixture(t); const before = f.snapshot();
  rejects('INSUFFICIENT_AUTHORITY', () => f.service.publish('producer-a', 'publish', publication()));
  rejects('INSUFFICIENT_AUTHORITY', () => f.service.publish('other-buyer', 'publish', publication()));
  rejects('STALE_REVISION', () => f.service.publish('buyer', 'publish', { ...publication(), expectedRevision: 2 }));
  rejects('INVALID_INPUT', () => f.service.publish('buyer', 'publish', { ...publication(), funded: true }));
  assert.deepEqual(f.snapshot(), before);
  f.service.publish('buyer', 'publish', publication()); const published = f.snapshot();
  rejects('INSUFFICIENT_AUTHORITY', () => f.service.purchase('buyer', 'buy', purchase()));
  rejects('INSUFFICIENT_AUTHORITY', () => f.service.purchase('ineligible-producer', 'buy', purchase()));
  rejects('STALE_REVISION', () => f.service.purchase('producer-a', 'buy', { ...purchase(), specRevision: 2 }));
  rejects('STALE_REVISION', () => f.service.purchase('producer-a', 'buy', { ...purchase(), termsRevision: 2 }));
  rejects('INVALID_INPUT', () => f.service.purchase('producer-a', 'buy', { ...purchase(), organization: 'buyer-org' }));
  assert.deepEqual(f.snapshot(), published);
});

test('revoked fixture authority cannot replay a prior successful command', t => {
  const f = fixture(t); f.service.publish('buyer', 'publish', publication());
  f.db.exec("UPDATE principals SET active = 0 WHERE id = 'buyer'"); const before = f.snapshot();
  rejects('INSUFFICIENT_AUTHORITY', () => f.service.publish('buyer', 'publish', publication()));
  assert.deepEqual(f.snapshot(), before);
});

test('invalid money, currencies, quantities, duplicate slots and expired terms never reserve funds', t => {
  const f = fixture(t); const before = f.snapshot();
  for (const compensation of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    rejects('INVALID_INPUT', () => f.service.publish('buyer', 'publish', publication('housing', compensation)));
  }
  const oversized = publication(); oversized.slots[0].quantity = 3;
  rejects('QUANTITY_EXCEEDED', () => f.service.publish('buyer', 'publish', oversized));
  const currency = publication(); currency.slots[0].currency = 'EUR';
  rejects('CURRENCY_MISMATCH', () => f.service.publish('buyer', 'publish', currency));
  const expired = publication(); expired.slots[0].expiresAt = FIXTURE_NOW;
  rejects('SLOT_EXPIRED', () => f.service.publish('buyer', 'publish', expired));
  const duplicate = publication(); duplicate.slots.push(duplicate.slots[0]);
  rejects('INVALID_INPUT', () => f.service.publish('buyer', 'publish', duplicate));
  const overflow = publication('housing', Number.MAX_SAFE_INTEGER); overflow.slots.push({ ...overflow.slots[0], id: 'second' });
  rejects('INVALID_INPUT', () => f.service.publish('buyer', 'publish', overflow));
  assert.deepEqual(f.snapshot(), before);
});

test('producer shortfall preserves the published buyer hold and allows another producer to buy', t => {
  const f = fixture(t); f.service.publish('buyer', 'publish', publication());
  f.db.exec("UPDATE accounts SET balance = 99 WHERE id = 'producer-a-funds'"); const before = f.snapshot();
  rejects('PRODUCER_FUNDS_UNAVAILABLE', () => f.service.purchase('producer-a', 'buy', purchase()));
  assert.deepEqual(f.snapshot(), before);
  f.service.purchase('producer-b', 'buy', purchase()); reconcile(f.db);
});

test('late outbox failure rolls back publication and purchase, then the same key can safely retry', t => {
  const f = fixture(t);
  const fail = () => f.db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  const recover = () => f.db.exec('DROP TRIGGER fail_outbox');
  fail(); const before = f.snapshot();
  assert.throws(() => f.service.publish('buyer', 'publish', publication()), /injected failure/);
  assert.deepEqual(f.snapshot(), before); recover(); f.service.publish('buyer', 'publish', publication());
  fail(); const published = f.snapshot();
  assert.throws(() => f.service.purchase('producer-a', 'buy', purchase()), /injected failure/);
  assert.deepEqual(f.snapshot(), published); recover(); f.service.purchase('producer-a', 'buy', purchase()); reconcile(f.db);
});

test('bounded lock contention returns a retryable error without effects; retry succeeds after unlock', t => {
  const f = fixture(t); const before = f.snapshot(); const impatient = new SlotService(f.path, () => FIXTURE_NOW, 1);
  try {
    f.db.exec('BEGIN IMMEDIATE');
    rejects('RETRYABLE_BUSY', () => impatient.publish('buyer', 'publish', publication()));
    f.db.exec('ROLLBACK'); assert.deepEqual(f.snapshot(), before);
    impatient.publish('buyer', 'publish', publication()); reconcile(f.db);
  } finally { if (f.db.isTransaction) f.db.exec('ROLLBACK'); impatient.close(); }
});

test('late release failure rolls back released funds and slot state; retry releases exactly once', t => {
  const f = fixture(t); f.service.publish('buyer', 'publish', publication());
  const input = { ...purchase(), reason: 'withdrawn' };
  f.db.exec("CREATE TRIGGER fail_release BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'injected release failure'); END");
  const before = f.snapshot();
  assert.throws(() => f.service.release('buyer', 'release', input), /injected release failure/);
  assert.deepEqual(f.snapshot(), before);
  f.db.exec('DROP TRIGGER fail_release');
  const result = f.service.release('buyer', 'release', input);
  assert.equal(result.released, 6_000);
  assert.deepEqual(f.service.release('buyer', 'release', input), result);
  assert.equal(account(f.db).reserved, 0); reconcile(f.db);
});

test('database constraints reject duplicate commitments and audit mutation', t => {
  const f = fixture(t); f.service.publish('buyer', 'publish', publication()); f.service.purchase('producer-a', 'buy', purchase());
  const before = f.snapshot();
  assert.throws(() => f.db.exec("INSERT INTO commitments SELECT 'duplicate', slot_id, producer_id, spec_revision, terms_revision, quantity, compensation, price, currency FROM commitments"), /UNIQUE/);
  assert.throws(() => f.db.exec("UPDATE audit_events SET operation = 'forged'"), /append-only/);
  assert.throws(() => f.db.exec('DELETE FROM audit_events'), /append-only/);
  assert.deepEqual(f.snapshot(), before);
});
