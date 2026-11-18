import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { BASELINE, fingerprint } from '../../contracts/src/index.ts';
import type { CommandInput, Input, MaterialInventoryLot, MarketOrder, Operation, Success, WorkStageLink } from '../../contracts/src/index.ts';
import { demand, result } from '../../domain/src/index.ts';

type Row = Record<string, unknown>;
type SourcingAuthority = { actor_id: string; organization_id: string; market_scopes: string[] };
export type SourcingContext = {
  authority: SourcingAuthority;
  visibleOrders(ids: string[], lock?: boolean): Promise<Row[]>;
  one(sql: string, values?: unknown[]): Promise<Row>;
  clock(): Promise<Date>;
  orderView(row: Row): Promise<MarketOrder>;
};
type CommandResult = { receipt: Success; orders: Row[]; organizations: string[]; privateRecord: true };
const n = (value: unknown): number => {
  const parsed = Number(value); demand(Number.isSafeInteger(parsed), 'VALIDATION_FAILED'); return parsed;
};
const json = (value: unknown): Success['data'][string] => value as Success['data'][string];
const iso = (value: unknown): string => (value as Date).toISOString();
async function one(client: PoolClient, sql: string, values: unknown[] = []): Promise<Row> {
  const row = (await client.query<Row>(sql, values)).rows[0]; demand(row, 'FORBIDDEN'); return row;
}
function lotView(row: Row): MaterialInventoryLot {
  return { lotId: row.id as string, itemId: row.item_id as string, specificationRevision: n(row.specification_revision),
    organizationId: row.organization_id as string, recordVersion: n(row.record_version), quantity: { value: n(row.quantity), unit: 'each' },
    usedQuantity: { value: n(row.used_quantity), unit: 'each' }, offeredQuantity: { value: n(row.offered_quantity), unit: 'each' },
    allocatedQuantity: { value: n(row.allocated_quantity), unit: 'each' }, availableQuantity: { value: n(row.available_quantity), unit: 'each' },
    sourceFulfillmentId: row.source_fulfillment_id as string | null, sourceLotId: row.source_lot_id as string | null,
    sourceCommitmentId: row.source_commitment_id as string | null, createdAt: iso(row.created_at), synthetic: true };
}
function stageView(row: Row): WorkStageLink {
  return { linkId: row.id as string, upstreamWorkOrderId: row.upstream_work_order_id as string,
    downstreamWorkOrderId: row.downstream_work_order_id as string, note: row.note as string,
    actorId: row.actor_id as string, organizationId: row.organization_id as string, createdAt: iso(row.created_at), synthetic: true, nonbinding: true };
}
function itemScoped(a: SourcingAuthority, itemId: unknown): boolean {
  return a.market_scopes.includes('*') || a.market_scopes.includes(itemId as string);
}
function orderScoped(a: SourcingAuthority, row: Row): boolean {
  return itemScoped(a, row.item_id) || a.market_scopes.includes(row.id as string);
}
async function ownLot(client: PoolClient, a: SourcingAuthority, lotId: string, lock = false): Promise<{ lot: Row; orders: Row[] }> {
  const lot = await one(client, `SELECT * FROM market_inventory_lots WHERE id=$1${lock ? ' FOR NO KEY UPDATE' : ''}`, [lotId]);
  demand(lot.organization_id === a.organization_id, 'FORBIDDEN');
  const listings = (await client.query<Row>('SELECT * FROM market_orders WHERE inventory_lot_id=$1 ORDER BY id', [lotId])).rows;
  let orders: Row[] = listings.filter(order => orderScoped(a, order));
  if (lot.source_commitment_id) {
    const commitment = await one(client, 'SELECT * FROM market_commitments WHERE id=$1', [lot.source_commitment_id]);
    demand(commitment.buyer_organization === a.organization_id, 'FORBIDDEN');
    const sourceOrders = (await client.query<Row>('SELECT * FROM market_orders WHERE id=ANY($1::text[]) ORDER BY id',
      [[commitment.buy_order_id, commitment.sell_order_id]])).rows;
    demand(sourceOrders.length === 2 && sourceOrders.every(order => orderScoped(a, order)), 'FORBIDDEN');
    orders = [...new Map([...sourceOrders, ...orders].map(order => [order.id, order])).values()];
  }
  demand(itemScoped(a, lot.item_id) || orders.length > 0, 'FORBIDDEN');
  return { lot, orders };
}
async function stageTargets(context: SourcingContext, upstream: string, downstream: string, lock = false): Promise<Row[]> {
  const orders = await context.visibleOrders([upstream, downstream], lock);
  demand(orders.every(order => order.kind === 'work_order'), 'MATCH_INVALID');
  demand(orders.some(order => order.organization_id === context.authority.organization_id), 'FORBIDDEN');
  return orders;
}

// Called by the existing repository after active-grant authentication, including
// before a cached receipt is returned. Scope revocation cannot replay private lots.
export async function authorizeSourcingTarget(client: PoolClient, context: SourcingContext, operation: Operation, input: CommandInput): Promise<void> {
  if (operation === 'recordMaterialUse') await ownLot(client, context.authority, (input as Input<'recordMaterialUse'>).lotId);
  if (operation === 'postMaterialListing') {
    const lotId = (input as Input<'postMaterialListing'>).sourceLotId;
    if (lotId) await ownLot(client, context.authority, lotId);
  }
  if (operation === 'linkWorkStages') {
    const cmd = input as Input<'linkWorkStages'>;
    await stageTargets(context, cmd.upstreamWorkOrderId, cmd.downstreamWorkOrderId);
  }
}

// The order INSERT already carries inventory_lot_id. This reservation and that
// INSERT commit together; no second publication can advertise the same units.
export async function reserveInventoryForListing(client: PoolClient, a: SourcingAuthority, order: Row, lotId: string): Promise<MaterialInventoryLot> {
  const { lot } = await ownLot(client, a, lotId, true);
  demand(order.organization_id === a.organization_id && order.inventory_lot_id === lotId, 'FORBIDDEN');
  demand(order.kind === 'material_listing' && order.supply_mode === 'stock' && order.item_id === lot.item_id
    && order.specification_revision === lot.specification_revision && order.unit === lot.unit, 'MATCH_INVALID');
  demand(n(order.quantity) <= n(lot.available_quantity), 'INVENTORY_UNAVAILABLE');
  await client.query('UPDATE market_inventory_lots SET offered_quantity=offered_quantity+$1,record_version=record_version+1 WHERE id=$2', [order.quantity, lotId]);
  return lotView(await one(client, 'SELECT * FROM market_inventory_lots WHERE id=$1', [lotId]));
}

// A committed seller allocation stays consumed even after delivery. Acquired
// buyer lots carry transfer provenance; summing both owners is not a stock total.
export async function allocateInventory(client: PoolClient, _buy: Row, sell: Row, _proposal: Row, quantity: number): Promise<MaterialInventoryLot | null> {
  if (!sell.inventory_lot_id) return null;
  const lot = await one(client, 'SELECT * FROM market_inventory_lots WHERE id=$1 FOR NO KEY UPDATE', [sell.inventory_lot_id]);
  demand(lot.organization_id === sell.organization_id && lot.item_id === sell.item_id
    && lot.specification_revision === sell.specification_revision && lot.unit === sell.unit, 'MATCH_INVALID');
  demand(quantity <= n(lot.offered_quantity), 'INVENTORY_UNAVAILABLE');
  await client.query('UPDATE market_inventory_lots SET offered_quantity=offered_quantity-$1,allocated_quantity=allocated_quantity+$1,record_version=record_version+1 WHERE id=$2', [quantity, lot.id]);
  return lotView(await one(client, 'SELECT * FROM market_inventory_lots WHERE id=$1', [lot.id]));
}

export async function acknowledgeInventoryAcquisition(client: PoolClient, commitment: Row, fulfillment: Row, a: SourcingAuthority): Promise<MaterialInventoryLot | null> {
  const sell = await one(client, 'SELECT * FROM market_orders WHERE id=$1', [commitment.sell_order_id]);
  if (sell.kind !== 'material_listing' || !sell.inventory_lot_id) return null;
  demand(commitment.buyer_organization === a.organization_id && fulfillment.acknowledged === true
    && fulfillment.commitment_id === commitment.id, 'FORBIDDEN');
  const lotId = randomUUID();
  await client.query(`INSERT INTO market_inventory_lots(id,item_id,specification_revision,organization_id,quantity,unit,source_fulfillment_id,source_lot_id,source_commitment_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [lotId, sell.item_id, sell.specification_revision, a.organization_id,
    fulfillment.quantity, fulfillment.unit, fulfillment.id, sell.inventory_lot_id, commitment.id]);
  return lotView(await one(client, 'SELECT * FROM market_inventory_lots WHERE id=$1', [lotId]));
}

export async function sourcingCommand(client: PoolClient, context: SourcingContext, operation: Operation, input: CommandInput): Promise<CommandResult | null> {
  const a = context.authority;
  if (operation === 'recordMaterialUse') {
    const cmd = input as Input<'recordMaterialUse'>;
    const { lot, orders } = await ownLot(client, a, cmd.lotId, true);
    demand(n(lot.record_version) === cmd.expectedRecordVersion, 'REVISION_CONFLICT');
    demand(lot.unit === cmd.quantity.unit && cmd.quantity.value <= n(lot.available_quantity), 'INVENTORY_UNAVAILABLE');
    const id = randomUUID(), instant = await context.clock();
    await client.query('INSERT INTO market_material_uses(id,lot_id,actor_id,organization_id,quantity,unit,note,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, lot.id, a.actor_id, a.organization_id, cmd.quantity.value, cmd.quantity.unit, cmd.note, instant]);
    await client.query('UPDATE market_inventory_lots SET used_quantity=used_quantity+$1,record_version=record_version+1 WHERE id=$2', [cmd.quantity.value, lot.id]);
    const updated = await one(client, 'SELECT * FROM market_inventory_lots WHERE id=$1', [lot.id]);
    return { receipt: result('used', { lotId: lot.id as string, materialUseId: id }, { lot: json(lotView(updated)) },
      { recordVersion: n(updated.record_version) }, null, 'list_material_leftover'), orders, organizations: [a.organization_id], privateRecord: true };
  }
  if (operation === 'linkWorkStages') {
    const cmd = input as Input<'linkWorkStages'>;
    // Graph changes serialize before sorted work-order locks. The recursive walk
    // is a cycle check only: it never expands demand or schedules execution.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('vista-verde-work-stage-graph',0))");
    const orders = await stageTargets(context, cmd.upstreamWorkOrderId, cmd.downstreamWorkOrderId, true);
    demand(cmd.upstreamWorkOrderId !== cmd.downstreamWorkOrderId, 'MATCH_INVALID');
    const cycle = await client.query(`WITH RECURSIVE downstream(id) AS (
      SELECT $1::text UNION SELECT s.downstream_work_order_id FROM market_stage_links s JOIN downstream d ON s.upstream_work_order_id=d.id
    ) SELECT 1 FROM downstream WHERE id=$2 LIMIT 1`, [cmd.downstreamWorkOrderId, cmd.upstreamWorkOrderId]);
    demand(cycle.rowCount === 0, 'MATCH_INVALID');
    const duplicate = await client.query('SELECT 1 FROM market_stage_links WHERE upstream_work_order_id=$1 AND downstream_work_order_id=$2',
      [cmd.upstreamWorkOrderId, cmd.downstreamWorkOrderId]);
    demand(duplicate.rowCount === 0, 'MATCH_INVALID');
    const id = randomUUID(), instant = await context.clock();
    await client.query(`INSERT INTO market_stage_links(id,upstream_work_order_id,downstream_work_order_id,actor_id,organization_id,note,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [id, cmd.upstreamWorkOrderId, cmd.downstreamWorkOrderId, a.actor_id, a.organization_id, cmd.note, instant]);
    const link = stageView(await one(client, 'SELECT * FROM market_stage_links WHERE id=$1', [id]));
    return { receipt: result('linked', { stageLinkId: id, upstreamWorkOrderId: cmd.upstreamWorkOrderId, downstreamWorkOrderId: cmd.downstreamWorkOrderId },
      { stageLink: json(link) }), orders, organizations: [...new Set([a.organization_id, ...orders.map(order => order.organization_id as string)])], privateRecord: true };
  }
  return null;
}

export async function sourcingQuery(client: PoolClient, context: SourcingContext, operation: Operation, input: Input<Operation>): Promise<Success | null> {
  if (operation !== 'getSourcingWorkspace') return null;
  const a = context.authority, filter = input as Input<'getSourcingWorkspace'>;
  const rows = (await client.query<Row>(`SELECT * FROM (
    SELECT 'lot' AS kind,l.id FROM market_inventory_lots l WHERE l.organization_id=$1
      AND ('*'=ANY($2::text[]) OR l.item_id=ANY($2::text[]) OR l.source_commitment_id IS NOT NULL OR EXISTS(SELECT 1 FROM market_orders o WHERE o.inventory_lot_id=l.id
        AND (o.id=ANY($2::text[]) OR o.item_id=ANY($2::text[]))))
      AND (l.source_commitment_id IS NULL OR EXISTS(SELECT 1 FROM market_commitments c JOIN market_orders b ON b.id=c.buy_order_id
        JOIN market_orders s ON s.id=c.sell_order_id WHERE c.id=l.source_commitment_id AND c.buyer_organization=$1
        AND ('*'=ANY($2::text[]) OR b.id=ANY($2::text[]) OR b.item_id=ANY($2::text[]))
        AND ('*'=ANY($2::text[]) OR s.id=ANY($2::text[]) OR s.item_id=ANY($2::text[]))))
    UNION ALL SELECT 'stage',l.id FROM market_stage_links l JOIN market_orders u ON u.id=l.upstream_work_order_id
      JOIN market_orders d ON d.id=l.downstream_work_order_id WHERE (l.organization_id=$1 OR u.organization_id=$1 OR d.organization_id=$1)
      AND ('*'=ANY($2::text[]) OR u.id=ANY($2::text[]) OR u.item_id=ANY($2::text[]))
      AND ('*'=ANY($2::text[]) OR d.id=ANY($2::text[]) OR d.item_id=ANY($2::text[]))
    ) records WHERE ($3::text IS NULL OR id>$3) ORDER BY id LIMIT $4`, [a.organization_id, a.market_scopes, filter.cursor ?? null, filter.limit + 1])).rows;
  const page = rows.slice(0, filter.limit), lots: MaterialInventoryLot[] = [], stageLinks: WorkStageLink[] = [];
  for (const row of page) {
    if (row.kind === 'lot') lots.push(lotView((await ownLot(client, a, row.id as string)).lot));
    else {
      const link = await one(client, 'SELECT * FROM market_stage_links WHERE id=$1', [row.id]);
      await context.visibleOrders([link.upstream_work_order_id as string, link.downstream_work_order_id as string]);
      stageLinks.push(stageView(link));
    }
  }
  return result('market', {}, { lots: json(lots), stageLinks: json(stageLinks), nextCursor: rows.length > filter.limit ? page.at(-1)!.id as string : null });
}

export async function seedSourcingLots(client: PoolClient): Promise<void> {
  await client.query("INSERT INTO market_inventory_lots(id,item_id,specification_revision,organization_id,quantity,unit) VALUES('timber-lot-a','TIMBER-DEMO',1,'producer-a-org',12,'each')");
}
export async function seedSourcingRecords(client: PoolClient): Promise<void> {
  const listing = await one(client, "SELECT * FROM market_orders WHERE id='materialtimber-a'");
  await reserveInventoryForListing(client, { actor_id: 'producer-a', organization_id: 'producer-a-org', market_scopes: ['*'] }, listing, 'timber-lot-a');
  const instant = (await one(client, 'SELECT clock_timestamp() AS instant')).instant as Date;
  const input: Input<'linkWorkStages'> = { idempotencyKey: 'seed-linear-stage-demo', upstreamWorkOrderId: 'material-input-work-b',
    downstreamWorkOrderId: 'panel-buy', note: 'Manual illustrative input-to-component stage reference. No quantity conversion, automatic execution, engineering claim or extra budget.' };
  const id = 'linear-stage-demo', actor = 'producer-b', organization = 'producer-b-org';
  await client.query(`INSERT INTO market_stage_links(id,upstream_work_order_id,downstream_work_order_id,actor_id,organization_id,note,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [id, input.upstreamWorkOrderId, input.downstreamWorkOrderId, actor, organization, input.note, instant]);
  const receipt = result('linked', { stageLinkId: id, upstreamWorkOrderId: input.upstreamWorkOrderId, downstreamWorkOrderId: input.downstreamWorkOrderId },
    { stageLink: json(stageView(await one(client, 'SELECT * FROM market_stage_links WHERE id=$1', [id]))) });
  const eventId = randomUUID(), orderIds = [input.upstreamWorkOrderId, input.downstreamWorkOrderId];
  const payload = { schemaVersion: BASELINE, eventId, actorId: actor, organizationId: organization, operation: 'linkWorkStages',
    happenedAt: instant.toISOString(), recordIds: receipt.recordIds, revisions: receipt.revisions, reason: 'seed_synthetic_fixture', synthetic: true };
  await client.query(`INSERT INTO market_audit_events(id,actor_id,organization_id,operation,order_ids,participant_organizations,private,payload,happened_at)
    VALUES($1,$2,$3,'linkWorkStages',$4,$5,true,$6,$7)`, [eventId, actor, organization, orderIds, [organization, 'buyer-org'], payload, instant]);
  await client.query('INSERT INTO market_outbox(event_id) VALUES($1)', [eventId]);
  await client.query(`INSERT INTO market_idempotency(actor_id,organization_id,operation,key,fingerprint,order_ids,private,participant_organizations,result)
    VALUES($1,$2,'linkWorkStages',$3,$4,$5,true,$6,$7)`, [actor, organization, input.idempotencyKey, fingerprint(input), orderIds, [organization, 'buyer-org'], receipt]);
}

// Backup/restore validation reads persisted ledgers instead of relying on a UI
// projection. A transfer lot represents acknowledged custody under demo terms;
// it is not newly manufactured inventory or proof of physical delivery.
export async function reconcileSourcing(client: PoolClient): Promise<void> {
  const checks = [
    `SELECT count(*) AS errors FROM market_inventory_lots l WHERE NOT l.synthetic
      OR l.quantity<>l.used_quantity+l.offered_quantity+l.allocated_quantity+l.available_quantity
      OR l.used_quantity<>(SELECT COALESCE(sum(u.quantity),0) FROM market_material_uses u WHERE u.lot_id=l.id)
      OR l.offered_quantity<>(SELECT COALESCE(sum(o.quantity-o.allocated_quantity),0) FROM market_orders o WHERE o.inventory_lot_id=l.id)
      OR l.allocated_quantity<>(SELECT COALESCE(sum(o.allocated_quantity),0) FROM market_orders o WHERE o.inventory_lot_id=l.id)`,
    `SELECT count(*) AS errors FROM market_orders o JOIN market_inventory_lots l ON l.id=o.inventory_lot_id
      WHERE o.kind<>'material_listing' OR o.supply_mode<>'stock' OR o.organization_id<>l.organization_id
      OR o.item_id<>l.item_id OR o.specification_revision<>l.specification_revision OR o.unit<>l.unit`,
    `SELECT count(*) AS errors FROM market_inventory_lots l JOIN market_fulfillments f ON f.id=l.source_fulfillment_id
      JOIN market_commitments c ON c.id=f.commitment_id JOIN market_orders s ON s.id=c.sell_order_id
      WHERE NOT f.acknowledged OR l.source_commitment_id<>c.id OR l.source_lot_id IS DISTINCT FROM s.inventory_lot_id
      OR l.organization_id<>c.buyer_organization OR l.quantity<>f.quantity OR l.unit<>f.unit
      OR l.item_id<>s.item_id OR l.specification_revision<>s.specification_revision`,
    `SELECT count(*) AS errors FROM market_fulfillments f JOIN market_commitments c ON c.id=f.commitment_id
      JOIN market_orders s ON s.id=c.sell_order_id LEFT JOIN market_inventory_lots l ON l.source_fulfillment_id=f.id
      WHERE f.acknowledged AND s.kind='material_listing' AND s.inventory_lot_id IS NOT NULL AND l.id IS NULL`,
    `SELECT count(*) AS errors FROM market_material_uses u JOIN market_inventory_lots l ON l.id=u.lot_id
      WHERE u.organization_id<>l.organization_id OR u.unit<>l.unit OR NOT u.synthetic
      OR NOT EXISTS(SELECT 1 FROM market_idempotency i WHERE i.operation='recordMaterialUse'
        AND i.result->'recordIds'->>'materialUseId'=u.id AND i.result->'recordIds'->>'lotId'=u.lot_id)`,
    `SELECT count(*) AS errors FROM market_stage_links l JOIN market_orders u ON u.id=l.upstream_work_order_id
      JOIN market_orders d ON d.id=l.downstream_work_order_id WHERE u.kind<>'work_order' OR d.kind<>'work_order'
      OR (l.organization_id<>u.organization_id AND l.organization_id<>d.organization_id) OR NOT l.synthetic OR NOT l.nonbinding
      OR NOT EXISTS(SELECT 1 FROM market_idempotency i WHERE i.operation='linkWorkStages' AND i.result->'recordIds'->>'stageLinkId'=l.id)`,
    `WITH RECURSIVE reachable(origin,id) AS (
      SELECT upstream_work_order_id,downstream_work_order_id FROM market_stage_links
      UNION SELECT r.origin,l.downstream_work_order_id FROM reachable r JOIN market_stage_links l ON l.upstream_work_order_id=r.id
    ) SELECT count(*) AS errors FROM reachable WHERE origin=id`
  ];
  for (const sql of checks) {
    if (Number((await client.query(sql)).rows[0].errors) !== 0) throw new Error('Synthetic sourcing reconciliation failed.');
  }
}
