import assert from 'node:assert/strict';
import type { Envelope,Input,Operation,Success } from '../../packages/contracts/src/index.ts';
import { marketOrderSchema,marketProposalSchema,marketCommitmentSchema,houseProjectSchema,marketWorkspaceSchema,sourcingWorkspaceSchema } from '../../packages/contracts/src/market.ts';
import { fixture,ok } from './helpers.ts';

export type MarketFixture = Awaited<ReturnType<typeof fixture>>;
export type Caller = (operation: Operation,input: unknown) => Promise<Envelope>;
export const execute = (f: MarketFixture,actor: string): Caller =>
  (operation,input) => f.application.execute(operation,input,f.context(actor));

export function orderInput(key: string,side: 'buy'|'sell',value=1,
  overrides: Partial<Input<'createMarketOrder'>>={}): Input<'createMarketOrder'> {
  return { idempotencyKey:key,itemId:'PANEL-DEMO',specificationRevision:1,side,
    ...(side==='sell' ? { supplyMode:'stock' as const } : {}),quantity:{value,unit:'each'},
    unitPrice:{minorUnits:9000,currency:'USD'},location:'Synthetic fixture yard',
    availableAt:new Date(Date.now()+3600000).toISOString(),deliveryBy:new Date(Date.now()+86400000).toISOString(),
    terms:'Illustrative goods only; receiver acknowledges counted each.',...overrides };
}
export function workOrderInput(key:string,value=12,budget=120000,overrides:Partial<Input<'postWorkOrder'>>={}):Input<'postWorkOrder'> {
  return {idempotencyKey:key,itemId:'PANEL-DEMO',specificationRevision:1,need:'Produce counted illustrative panels for the demo site.',
    quantity:{value,unit:'each'},budget:{minorUnits:budget,currency:'USD'},location:'Synthetic receiving site',
    availableAt:new Date(Date.now()).toISOString(),deliveryBy:new Date(Date.now()+7*86400000).toISOString(),
    terms:'Synthetic work; seller reports counted fulfillment and buyer explicitly acknowledges.',...overrides};
}
export function materialListingInput(key:string,value=10,overrides:Partial<Input<'postMaterialListing'>>={}):Input<'postMaterialListing'> {
  return {idempotencyKey:key,itemId:'TIMBER-DEMO',specificationRevision:1,quantity:{value,unit:'each'},
    unitPrice:{minorUnits:1000,currency:'USD'},supplyMode:'stock',location:'Synthetic material yard',
    availableAt:new Date(Date.now()).toISOString(),deliveryBy:new Date(Date.now()+7*86400000).toISOString(),
    terms:'Synthetic material source; purchase requires separate explicit agreement.',...overrides};
}
export function responseInput(key:string,workOrderId:string,value=8,price=9000,overrides:Partial<Input<'respondToWorkOrder'>>={}):Input<'respondToWorkOrder'> {
  return {idempotencyKey:key,workOrderId,expectedRecordVersion:1,quantity:{value,unit:'each'},unitPrice:{minorUnits:price,currency:'USD'},
    supplyMode:'made_to_order',location:'Synthetic producer workshop',availableAt:new Date(Date.now()).toISOString(),
    deliveryBy:new Date(Date.now()+6*86400000).toISOString(),terms:'Synthetic production; material sourcing and receiver acknowledgement remain explicit.',
    expiresAt:new Date(Date.now()+60000).toISOString(),...overrides};
}
export function proposalInput(key: string,buyOrderId='panel-buy',sellOrderId='panel-sell-a',value=8,
  overrides: Partial<Input<'proposeMarketAllocation'>>={}): Input<'proposeMarketAllocation'> {
  return { idempotencyKey:key,buyOrderId,sellOrderId,expectedBuyVersion:1,expectedSellVersion:1,
    quantity:{value,unit:'each'},unitPrice:{minorUnits:9000,currency:'USD'},
    expiresAt:new Date(Date.now()+60000).toISOString(),...overrides };
}
export const confirmationInput = (key: string,proposalId: string,expectedRecordVersion: number): Input<'confirmMarketProposal'> =>
  ({idempotencyKey:key,proposalId,expectedRecordVersion});
export const reportInput = (key: string,commitmentId: string,expectedRecordVersion: number,value: number): Input<'reportMarketFulfillment'> =>
  ({idempotencyKey:key,commitmentId,expectedRecordVersion,quantity:{value,unit:'each'},note:'Synthetic counted delivery report'});
export const acknowledgementInput = (key: string,fulfillmentId: string,expectedRecordVersion=1): Input<'acknowledgeMarketFulfillment'> =>
  ({idempotencyKey:key,fulfillmentId,expectedRecordVersion});

export function record<T>(receipt: Envelope,key: string): T {
  const value=ok(receipt).data[key];
  assert.ok(value !== undefined,`The response includes ${key}`);
  return value as T;
}
export function recordId(receipt: Success,key: string): string {
  const value=receipt.recordIds[key]; assert.ok(value,`The receipt includes ${key}`); return value;
}
export const getOrder = async (call: Caller,orderId: string) => marketOrderSchema.parse(record(await call('getMarketOrder',{orderId}),'order'));
export const getProposal = async (call: Caller,proposalId: string) => marketProposalSchema.parse(record(await call('getMarketProposal',{proposalId}),'proposal'));
export const getCommitment = async (call: Caller,commitmentId: string) => marketCommitmentSchema.parse(record(await call('getMarketCommitment',{commitmentId}),'commitment'));
export const getProject = async (call: Caller) => houseProjectSchema.parse(record(await call('getHouseProject',{projectId:'house-demo'}),'project'));
export const getWorkspace = async (call: Caller) => marketWorkspaceSchema.parse(ok(await call('getMarketWorkspace',{})).data);
export const getSourcing = async (call: Caller) => sourcingWorkspaceSchema.parse(ok(await call('getSourcingWorkspace',{limit:100})).data);

// Capture persisted records, including rejected-command side effects, rather than
// comparing only a projection whose missing rows could mask a partial transaction.
async function rows(f: MarketFixture,tables: readonly string[]) {
  const result: Record<string,unknown>={};
  for (const table of tables) {
    result[table]=(await f.pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}
export const financialSnapshot = (f: MarketFixture) => rows(f,['accounts','holds','journal_entries']);
export const marketSnapshot = async (f: MarketFixture) => {
  const names=(await f.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND left(table_name,7)='market_' ORDER BY table_name")).rows.map(row=>row.table_name as string);
  return rows(f,['grants','memberships',...names,'accounts','holds','journal_entries']);
};

export async function noMutation(f: MarketFixture,action: () => Promise<unknown>) {
  const before=await marketSnapshot(f); await action(); assert.deepEqual(await marketSnapshot(f),before);
}

export async function noFinancialEffects(f: MarketFixture,before: Awaited<ReturnType<typeof financialSnapshot>>) {
  assert.deepEqual(await financialSnapshot(f),before,'Generic goods activity never reserves or transfers synthetic money');
  await f.reconcile();
}

export async function orderCounters(f: MarketFixture,orderId: string) {
  const found=(await f.pool.query('SELECT quantity,allocated_quantity,state FROM market_orders WHERE id=$1',[orderId])).rows[0];
  assert.ok(found); return { total:Number(found.quantity),allocated:Number(found.allocated_quantity),state:found.state as string };
}
export async function commitmentCounters(f: MarketFixture,commitmentId: string) {
  const found=(await f.pool.query('SELECT quantity,reported_quantity,acknowledged_quantity,record_version,state FROM market_commitments WHERE id=$1',[commitmentId])).rows[0];
  assert.ok(found); return { total:Number(found.quantity),reported:Number(found.reported_quantity),acknowledged:Number(found.acknowledged_quantity),version:Number(found.record_version),state:found.state as string };
}
export async function proposalVersion(f: MarketFixture,proposalId: string) {
  const found=(await f.pool.query('SELECT record_version FROM market_proposals WHERE id=$1',[proposalId])).rows[0];
  assert.ok(found); return Number(found.record_version);
}
export async function propose(f: MarketFixture,input: Input<'proposeMarketAllocation'>,actor='buyer') {
  return recordId(ok(await execute(f,actor)('proposeMarketAllocation',input)),'proposalId');
}
export async function approve(f: MarketFixture,proposalId: string,actor: string,key=`approve-${actor}-${proposalId}`,call=execute(f,actor)) {
  return ok(await call('confirmMarketProposal',confirmationInput(key,proposalId,await proposalVersion(f,proposalId))));
}
export async function commit(f: MarketFixture,input: Input<'proposeMarketAllocation'>,seller='producer-a',buyer='buyer') {
  const proposalId=await propose(f,input,buyer); await approve(f,proposalId,buyer);
  return recordId(await approve(f,proposalId,seller),'commitmentId');
}
export async function reportAndAcknowledge(f: MarketFixture,commitmentId: string,value: number,seller='producer-a',key=`delivery-${value}`,buyer='buyer') {
  const current=await commitmentCounters(f,commitmentId);
  const report=reportInput(key,commitmentId,current.version,value);
  const reported=ok(await execute(f,seller)('reportMarketFulfillment',report));
  const acknowledgement=acknowledgementInput(key,recordId(reported,'fulfillmentId'));
  const acknowledged=ok(await execute(f,buyer)('acknowledgeMarketFulfillment',acknowledgement));
  return { report,reported,acknowledgement,acknowledged };
}

export async function reconcileMarket(f: MarketFixture) {
  const over=(await f.pool.query(`SELECT o.id FROM market_orders o LEFT JOIN market_commitments c
    ON (o.side='buy' AND c.buy_order_id=o.id) OR (o.side='sell' AND c.sell_order_id=o.id)
    GROUP BY o.id HAVING COALESCE(SUM(c.quantity),0)<>o.allocated_quantity OR SUM(c.quantity)>o.quantity`));
  assert.equal(over.rowCount,0,'All commitments, including completed ones, consume both orders');
  const quantities=await f.pool.query(`SELECT c.id FROM market_commitments c LEFT JOIN market_fulfillments f ON f.commitment_id=c.id
    GROUP BY c.id HAVING COALESCE(SUM(f.quantity),0)<>c.reported_quantity
    OR COALESCE(SUM(f.quantity) FILTER(WHERE f.acknowledged),0)<>c.acknowledged_quantity`);
  assert.equal(quantities.rowCount,0,'Reports and receiver acknowledgements are separate bounded counts');
  const orphan=await f.pool.query('SELECT id FROM market_audit_events WHERE id NOT IN (SELECT event_id FROM market_outbox)');
  assert.equal(orphan.rowCount,0,'Every recorded action has an atomic outbox event');
  const counts=(await f.pool.query('SELECT (SELECT count(*) FROM market_audit_events) AS events,(SELECT count(*) FROM market_idempotency) AS results')).rows[0];
  assert.equal(counts.events,counts.results,'One durable event per distinct successful request');
  const budgets=await f.pool.query(`SELECT o.id FROM market_orders o LEFT JOIN market_commitments c ON c.buy_order_id=o.id
    LEFT JOIN market_proposals p ON p.id=c.proposal_id WHERE o.kind='work_order'
    GROUP BY o.id HAVING COALESCE(SUM(c.quantity*p.unit_price),0)<>o.budget_committed OR SUM(c.quantity*p.unit_price)>o.budget`);
  assert.equal(budgets.rowCount,0,'Confirmed proposal values, including completed ones, remain within each stated total budget');
  const lots=await f.pool.query(`SELECT l.id FROM market_inventory_lots l WHERE l.quantity<>l.used_quantity+l.offered_quantity+l.allocated_quantity+l.available_quantity
    OR l.used_quantity<>(SELECT COALESCE(SUM(u.quantity),0) FROM market_material_uses u WHERE u.lot_id=l.id)
    OR l.offered_quantity<>(SELECT COALESCE(SUM(o.quantity-o.allocated_quantity),0) FROM market_orders o WHERE o.inventory_lot_id=l.id)
    OR l.allocated_quantity<>(SELECT COALESCE(SUM(o.allocated_quantity),0) FROM market_orders o WHERE o.inventory_lot_id=l.id)`);
  assert.equal(lots.rowCount,0,'Each synthetic lot conserves its own disjoint used, offered, allocated and available quantities');
}
