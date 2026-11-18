import { createHash,createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import type { PoolClient } from 'pg';
import { BASELINE } from '../../contracts/src/index.ts';
import { seedRecords } from './fixtures.ts';
import { reconcileSourcing } from './work-sourcing.ts';

const actors=['buyer-agent','buyer','buyer-second','other-buyer','other-agent','producer-a','producer-b','operator'];
export const businessTables=['accounts','memberships','specifications','fixture_terms','capabilities','requirements','requirement_lines','slots','commitments','holds','journal_entries','audit_events','outbox','idempotency','fixture_aliases','foundation_schema','market_schema','market_items','market_orders','market_proposals','market_approvals','market_commitments','market_fulfillments','market_projects','market_project_orders','market_audit_events','market_outbox','market_idempotency','market_material_links','market_inventory_lots','market_material_uses','market_stage_links'] as const;
export function fixtureTokens(key: string): Record<string,string> {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid local fixture key.');
  return Object.fromEntries(actors.map(actor => [actor,createHmac('sha256',Buffer.from(key,'hex')).update(`vista-verde-local-v1:${actor}`).digest('base64url')]));
}
export async function bootstrapLocal(pool: pg.Pool,key: string): Promise<void> {
  const tokens=fixtureTokens(key),binding=createHash('sha256').update(key).digest('hex');
  const sql=[readFileSync(new URL('../migrations/001-foundation.sql',import.meta.url),'utf8'),readFileSync(new URL('../migrations/002-market.sql',import.meta.url),'utf8'),readFileSync(new URL('../migrations/003-work-orders.sql',import.meta.url),'utf8'),readFileSync(new URL('../migrations/004-sourcing.sql',import.meta.url),'utf8')].join('\n');
  const checksum=createHash('sha256').update(sql).digest('hex'); const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('vista-verde-local-bootstrap',0))");
    const names=(await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name")).rows.map(row => row.table_name as string);
    if (!names.length) {
      await client.query(sql);
      await client.query('CREATE TABLE local_operation_state(id boolean PRIMARY KEY CHECK(id),schema_checksum text NOT NULL,key_binding text NOT NULL,initialized_at timestamptz NOT NULL DEFAULT clock_timestamp())');
      const instant=(await client.query('SELECT clock_timestamp() AS instant')).rows[0].instant as Date;
      await seedRecords(client,{ tokens,expiresAt:new Date(instant.getTime()+30*86400000) });
      await client.query('INSERT INTO local_operation_state(id,schema_checksum,key_binding) VALUES(true,$1,$2)',[checksum,binding]);
    } else {
      const expected=[...businessTables,'grants','local_operation_state'].sort();
      if (JSON.stringify(names)!==JSON.stringify(expected)) throw new Error('Existing database is not the approved local schema.');
      const state=(await client.query('SELECT * FROM local_operation_state WHERE id=true')).rows;
      const versions=(await client.query('SELECT version FROM foundation_schema')).rows;
      const marketVersions=(await client.query('SELECT version FROM market_schema')).rows;
      if (state.length!==1 || state[0].schema_checksum!==checksum || state[0].key_binding!==binding || versions.length!==1 || versions[0].version!==BASELINE || marketVersions.length!==1 || marketVersions[0].version!=='market.v0.3') throw new Error('Local schema or credential binding mismatch.');
      // Existing funds, grants (including used budgets/revocation), and records are untouched.
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
export type BusinessSnapshot = { checksum: string; counts: Record<string,number> };
export async function businessSnapshot(client: PoolClient): Promise<BusinessSnapshot> {
  const hash=createHash('sha256'),counts: Record<string,number>={};
  for (const table of businessTables) {
    const data=(await client.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS records FROM ${table} t`)).rows[0].records as unknown[];
    counts[table]=data.length; hash.update(JSON.stringify([table,data]));
  }
  return { checksum:hash.digest('hex'),counts };
}
export async function reconcileLocal(client: PoolClient): Promise<void> {
  const checks=[
    `SELECT count(*) AS errors FROM accounts a WHERE NOT a.synthetic OR a.reserved<>(SELECT COALESCE(sum(h.amount),0) FROM holds h WHERE h.buyer_account=a.id AND h.state IN ('held','committed'))`,
    `SELECT count(*) AS errors FROM slots s LEFT JOIN commitments c ON c.slot_id=s.id LEFT JOIN holds h ON h.slot_id=s.id WHERE h.slot_id IS NULL OR (s.state='purchased')<>(c.id IS NOT NULL) OR (s.state='purchased')<>(h.state='committed') OR (s.state IN ('withdrawn','expired'))<>(h.state='released') OR h.amount<>s.compensation`,
    `SELECT count(*) AS errors FROM commitments c JOIN slots s ON s.id=c.slot_id WHERE (SELECT count(*) FROM journal_entries j WHERE j.commitment_id=c.id)<>2 OR (SELECT sum(j.amount) FROM journal_entries j WHERE j.commitment_id=c.id)<>0 OR (SELECT max(abs(j.amount)) FROM journal_entries j WHERE j.commitment_id=c.id)<>s.price`,
    `SELECT count(*) AS errors FROM audit_events a LEFT JOIN outbox o ON o.event_id=a.id WHERE o.event_id IS NULL`,
    `SELECT count(*) AS errors FROM commitments c WHERE NOT EXISTS(SELECT 1 FROM idempotency i WHERE i.operation='purchaseSlot' AND i.result->'recordIds'->>'commitmentId'=c.id AND i.result=c.receipt)`,
    `SELECT count(*) AS errors FROM market_orders o WHERE o.allocated_quantity<>(SELECT COALESCE(sum(c.quantity),0) FROM market_commitments c WHERE c.buy_order_id=o.id OR c.sell_order_id=o.id)`,
    `SELECT count(*) AS errors FROM market_commitments c JOIN market_proposals p ON p.id=c.proposal_id JOIN market_orders b ON b.id=c.buy_order_id JOIN market_orders s ON s.id=c.sell_order_id WHERE c.quantity<>p.quantity OR b.side<>'buy' OR s.side<>'sell' OR b.item_id<>s.item_id OR b.specification_revision<>s.specification_revision OR b.unit<>s.unit OR c.buyer_organization<>b.organization_id OR c.seller_organization<>s.organization_id OR b.organization_id=s.organization_id`,
    `SELECT count(*) AS errors FROM market_commitments c WHERE c.reported_quantity<>(SELECT COALESCE(sum(f.quantity),0) FROM market_fulfillments f WHERE f.commitment_id=c.id) OR c.acknowledged_quantity<>(SELECT COALESCE(sum(f.quantity),0) FROM market_fulfillments f WHERE f.commitment_id=c.id AND f.acknowledged)`,
    `SELECT count(*) AS errors FROM market_proposals p WHERE (p.state='committed')<>(EXISTS(SELECT 1 FROM market_commitments c WHERE c.proposal_id=p.id)) OR (SELECT count(*) FROM market_approvals a WHERE a.proposal_id=p.id)<>CASE p.state WHEN 'proposed' THEN 0 WHEN 'partially_approved' THEN 1 ELSE 2 END`,
    `SELECT count(*) AS errors FROM market_audit_events a LEFT JOIN market_outbox o ON o.event_id=a.id WHERE o.event_id IS NULL`,
    `SELECT abs((SELECT count(*) FROM market_audit_events)-(SELECT count(*) FROM market_idempotency)) AS errors`,
    `SELECT count(*) AS errors FROM market_commitments c WHERE NOT EXISTS(SELECT 1 FROM market_idempotency i WHERE i.operation='confirmMarketProposal' AND i.result->'recordIds'->>'commitmentId'=c.id)`,
    `SELECT count(*) AS errors FROM market_orders o WHERE o.kind='work_order' AND o.budget_committed<>(SELECT COALESCE(sum(c.quantity*p.unit_price),0) FROM market_commitments c JOIN market_proposals p ON p.id=c.proposal_id WHERE c.buy_order_id=o.id)`,
    `SELECT count(*) AS errors FROM market_orders o LEFT JOIN market_orders w ON w.id=o.linked_work_order_id WHERE o.kind='capacity_offer' AND (w.id IS NULL OR w.kind<>'work_order' OR w.organization_id=o.organization_id OR w.item_id<>o.item_id OR w.specification_revision<>o.specification_revision)`,
    `SELECT count(*) AS errors FROM market_material_links l JOIN market_orders w ON w.id=l.work_order_id JOIN market_orders m ON m.id=l.material_listing_id WHERE w.kind<>'work_order' OR m.kind<>'material_listing' OR NOT l.synthetic OR NOT l.nonbinding OR NOT EXISTS(SELECT 1 FROM market_idempotency i WHERE i.operation='linkMaterialSource' AND i.result->'recordIds'->>'linkId'=l.id)`
  ];
  for (const sql of checks) if (Number((await client.query(sql)).rows[0].errors)!==0) throw new Error('Local record/hold/journal reconciliation failed.');
  await reconcileSourcing(client);
}
