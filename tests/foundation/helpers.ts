import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { localPool,migrate,PostgresRepository } from '../../packages/db/src/postgres.ts';
import { seed,draft,publication } from '../../packages/db/src/fixtures.ts';
import { Application } from '../../packages/domain/src/index.ts';
import type { Envelope,Success,ErrorCode } from '../../packages/contracts/src/index.ts';

export function ok(receipt: Envelope): Success { assert.equal(receipt.ok,true,JSON.stringify(receipt)); return receipt as Success; }
export function failure(receipt: Envelope,code: ErrorCode) { assert.equal(receipt.ok,false,JSON.stringify(receipt)); if (!receipt.ok) assert.equal(receipt.code,code); }
export async function fixture(t: TestContext) {
  const root = process.env.VV_TEST_DATABASE_URL; if (!root) throw new Error('Use npm run test:foundation to provision an isolated database.');
  const admin = localPool(root); const name = `vv_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(root); url.pathname=`/${name}`; const connectionString = url.toString();
  const pool = localPool(connectionString);
  const resources: (() => Promise<unknown>)[]=[];
  const cleanupWith=(close: () => Promise<unknown>) => { resources.push(close); };
  t.after(async () => {
    for (const close of resources.reverse()) await close();
    await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end();
  });
  await migrate(pool); const credentials = await seed(pool);
  const repository = new PostgresRepository(pool); const application = new Application(repository);
  const context = (actor: string) => credentials[actor]!.context;
  const token = (actor: string) => credentials[actor]!.token;
  const snapshot = async () => {
    const tables = ['accounts','grants','requirements','requirement_lines','slots','holds','commitments','journal_entries','audit_events','outbox','idempotency'];
    const result: Record<string,unknown> = {};
    for (const table of tables) result[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    return result;
  };
  async function publish(slotId: string,compensation = 6000,specificationId = 'housing-panel',expiresAt?: string) {
    const receipt = ok(await application.execute('createRequirementDraft',draft(`draft-${slotId}`,specificationId),context('buyer-agent')));
    const requirementId = receipt.recordIds.requirementId!;
    const input = publication(requirementId,slotId,compensation,expiresAt); input.slots[0]!.specificationId=specificationId;
    ok(await application.execute('publishRequirement',input,context('buyer')));
    return { requirementId,input };
  }
  async function reconcile() {
    const holds = await pool.query(`SELECT a.id FROM accounts a LEFT JOIN holds h ON h.buyer_account=a.id AND h.state<>'released'
      GROUP BY a.id HAVING a.reserved<>COALESCE(SUM(h.amount),0) OR a.reserved>a.balance`);
    assert.equal(holds.rowCount,0);
    const journals = await pool.query('SELECT commitment_id,currency FROM journal_entries GROUP BY commitment_id,currency HAVING SUM(amount)<>0');
    assert.equal(journals.rowCount,0);
    const orphan = await pool.query(`SELECT id FROM audit_events WHERE id NOT IN (SELECT event_id FROM outbox)`); assert.equal(orphan.rowCount,0);
    const counts = (await pool.query('SELECT (SELECT count(*) FROM audit_events) AS events,(SELECT count(*) FROM idempotency) AS results')).rows[0];
    assert.equal(counts.events,counts.results);
  }
  return { pool,repository,application,connectionString,context,token,credentials,snapshot,publish,reconcile,cleanupWith };
}
