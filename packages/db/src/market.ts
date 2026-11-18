import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { PoolClient } from 'pg';
import { BASELINE, fingerprint, success, marketCommandNames as contractMarketCommandNames } from '../../contracts/src/index.ts';
import type { Context, Command, CommandInput, Input, Operation, Success, MarketItem, MarketOrder, MarketProposal, MarketCommitment, MarketFulfillment, MaterialSourceLink } from '../../contracts/src/index.ts';
import { BusinessError, demand, result, safeTotal } from '../../domain/src/index.ts';
import { authorizeSourcingTarget, sourcingCommand, sourcingQuery, reserveInventoryForListing, allocateInventory, acknowledgeInventoryAcquisition } from './work-sourcing.ts';
import type { SourcingContext } from './work-sourcing.ts';
import {printRequirementsSchema,PRINT_MATERIAL_ITEM} from '../../contracts/src/market.ts';

// A profile inside the authoritative PostgresRepository, never an adapter or a
// second application service. Its transaction includes audit, intent and replay.
export const marketQueryNames = ['getSourcingWorkspace','listWorkOrders','listMaterialListings','listMarketItems','getMarketItem','getMarketWorkspace','getMarketOrder','getMarketProposal','getMarketCommitment','getHouseProject','getMarketAudit'] as const;
export const marketCommandNames = contractMarketCommandNames;
export const isMarketOperation = (operation: string): boolean => [...marketQueryNames,...marketCommandNames].includes(operation as typeof marketQueryNames[number]);
type Row = Record<string, unknown>;
type Authority = Row & { id: string; actor_id: string; organization_id: string; role: string; operations: string[]; market_scopes: string[]; expires_at: Date; revoked: boolean; active: boolean };
type Authorities = { current: Authority; grants: Map<string,Authority> };
const enrollment = ['buyer_agent','buyer_human','producer'];
const roleCommands: Record<string, readonly string[]> = {
  buyer_agent: ['createMarketOrder','proposeMarketAllocation','postWorkOrder','postMaterialListing','respondToWorkOrder','linkMaterialSource','linkWorkStages'],
  buyer_human: marketCommandNames, producer: marketCommandNames, operator: []
};
const n = (value: unknown): number => { const parsed=Number(value); demand(Number.isSafeInteger(parsed),'VALIDATION_FAILED'); return parsed; };
const iso = (value: unknown): string => (value as Date).toISOString();
const product = (quantity: unknown,price: unknown): number => { const value=n(quantity)*n(price); demand(Number.isSafeInteger(value),'VALIDATION_FAILED'); return value; };
const json = (value: unknown): Success['data'][string] => value as Success['data'][string];
async function one(client: PoolClient, sql: string, values: unknown[]=[]): Promise<Row> {
  const found=(await client.query<Row>(sql,values)).rows[0]; demand(found,'FORBIDDEN'); return found;
}
async function clock(client: PoolClient): Promise<Date> { return (await one(client,'SELECT clock_timestamp() AS instant')).instant as Date; }
function active(a: Authority, instant: Date, operation: string): void {
  demand(a.active && !a.revoked && a.expires_at.getTime()>instant.getTime() && enrollment.includes(a.role)
    && a.operations.includes(operation) && (marketQueryNames.includes(operation as typeof marketQueryNames[number]) || roleCommands[a.role]?.includes(operation)), 'FORBIDDEN');
}
function permits(a: Authority, order: Row): boolean {
  const scoped=a.market_scopes.includes('*') || a.market_scopes.includes(order.id as string) || a.market_scopes.includes(order.item_id as string)
    || (order.kind==='capacity_offer' && a.market_scopes.includes(order.linked_work_order_id as string));
  return scoped && (order.kind!=='capacity_offer' || order.organization_id===a.organization_id || order.linked_organization===a.organization_id);
}
function scope(a: Authority, order: Row): void { demand(permits(a,order),'FORBIDDEN'); }
function participant(a: Authority, record: Row): void { demand(a.organization_id===record.buyer_organization || a.organization_id===record.seller_organization,'FORBIDDEN'); }
async function orderRows(client: PoolClient, ids: string[], lock=false): Promise<Row[]> {
  const rows=(await client.query<Row>(`SELECT o.*,w.organization_id AS linked_organization FROM market_orders o LEFT JOIN market_orders w ON w.id=o.linked_work_order_id WHERE o.id=ANY($1::text[]) ORDER BY o.id${lock ? ' FOR UPDATE OF o' : ''}`,[[...new Set(ids)].sort()])).rows;
  demand(rows.length===new Set(ids).size,'FORBIDDEN'); return rows;
}
async function visibleOrders(client: PoolClient, a: Authority, ids: string[], lock=false): Promise<Row[]> {
  const rows=await orderRows(client,ids,lock); rows.forEach(order => scope(a,order)); return rows;
}
async function participantRecord(client: PoolClient, a: Authority, table: 'market_proposals'|'market_commitments', id: string, lock=false): Promise<Row> {
  const record=await one(client,`SELECT * FROM ${table} WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,[id]);
  participant(a,record); await visibleOrders(client,a,[record.buy_order_id as string,record.sell_order_id as string]); return record;
}
async function authority(client: PoolClient, context: Context, operation: string, input?: CommandInput): Promise<Authorities> {
  const sql=`SELECT g.*,m.organization_id,m.role,m.active FROM grants g JOIN memberships m ON m.actor_id=g.actor_id`;
  const initial=await one(client,`${sql} WHERE g.id=$1`,[context.grantId]) as Authority;
  demand(initial.actor_id===context.actorId && initial.organization_id===context.organizationId,'FORBIDDEN');
  active(initial,await clock(client),operation);
  // Identity locks always precede business locks. Both counterparties lock the
  // same sorted set, including historic approval grants, avoiding A/B lock inversion.
  let organizations=[initial.organization_id];
  if (input && operation==='proposeMarketAllocation') {
    const proposal=input as Input<'proposeMarketAllocation'>;
    const orders=await visibleOrders(client,initial,[proposal.buyOrderId,proposal.sellOrderId]);
    demand(orders.some(o => o.organization_id===initial.organization_id),'FORBIDDEN');
    organizations=orders.map(o => o.organization_id as string);
  } else if (input && operation==='respondToWorkOrder') {
    const work=(await visibleOrders(client,initial,[(input as Input<'respondToWorkOrder'>).workOrderId]))[0]!;
    organizations=[work.organization_id as string,initial.organization_id];
  } else if (input && operation==='linkMaterialSource') {
    const link=input as Input<'linkMaterialSource'>;
    const records=await visibleOrders(client,initial,[link.workOrderId,link.materialListingId]);
    organizations=[initial.organization_id,...records.map(r => r.organization_id as string)];
  } else if (input && operation==='confirmMarketProposal') {
    const p=await participantRecord(client,initial,'market_proposals',(input as Input<'confirmMarketProposal'>).proposalId);
    organizations=[p.buyer_organization as string,p.seller_organization as string];
  } else if (input && operation==='reportMarketFulfillment') {
    const c=await participantRecord(client,initial,'market_commitments',(input as Input<'reportMarketFulfillment'>).commitmentId);
    organizations=[c.buyer_organization as string,c.seller_organization as string];
  } else if (input && operation==='acknowledgeMarketFulfillment') {
    const f=await one(client,'SELECT * FROM market_fulfillments WHERE id=$1',[(input as Input<'acknowledgeMarketFulfillment'>).fulfillmentId]);
    const c=await participantRecord(client,initial,'market_commitments',f.commitment_id as string);
    organizations=[c.buyer_organization as string,c.seller_organization as string];
  }
  const locked=(await client.query<Authority>(`${sql} WHERE g.id=$1 OR m.organization_id=ANY($2::text[]) ORDER BY g.id FOR UPDATE OF g`,[context.grantId,[...new Set(organizations)].sort()])).rows;
  const memberships=(await client.query<Row>('SELECT * FROM memberships WHERE actor_id=ANY($1::text[]) ORDER BY actor_id FOR SHARE',[locked.map(g => g.actor_id).sort()])).rows;
  const grants=new Map(locked.map(g => {
    const m=memberships.find(m => m.actor_id===g.actor_id)!;
    return [g.id,{ ...g,organization_id:m.organization_id,role:m.role,active:m.active } as Authority];
  }));
  const current=grants.get(context.grantId)!;
  demand(current.actor_id===context.actorId && current.organization_id===context.organizationId,'FORBIDDEN');
  active(current,await clock(client),operation); return { current,grants };
}
function itemView(r: Row): MarketItem {
  return { itemId:r.id as string,name:r.name as string,description:r.description as string,specificationRevision:n(r.specification_revision),
    specificationLabel:r.specification_label as string,unit:'each',specification:r.specification as MarketItem['specification'],synthetic:true };
}
async function orderView(client: PoolClient, r: Row): Promise<MarketOrder> {
  const item=await one(client,'SELECT specification FROM market_items WHERE id=$1 AND specification_revision=$2',[r.item_id,r.specification_revision]);
  const spec=item.specification as Record<string,unknown>;
  const printRequirements=spec.kind==='mock-print-job' ? printRequirementsSchema.parse(spec.printRequirements):undefined;
  const totals=await one(client,`SELECT COALESCE(sum(reported_quantity),0) AS reported,COALESCE(sum(acknowledged_quantity),0) AS acknowledged
    FROM market_commitments WHERE buy_order_id=$1 OR sell_order_id=$1`,[r.id]);
  return { ...(printRequirements?{printRequirements}:{}),orderId:r.id as string,itemId:r.item_id as string,specificationRevision:n(r.specification_revision),side:r.side as 'buy'|'sell',
    ...(r.supply_mode ? { supplyMode:r.supply_mode as 'stock'|'made_to_order' } : {}),organizationId:r.organization_id as string,
    kind:r.kind as MarketOrder['kind'],need:r.need as string|null,budget:r.budget===null ? null : {minorUnits:n(r.budget),currency:'USD'},
    budgetCommitted:r.budget===null ? null : {minorUnits:n(r.budget_committed),currency:'USD'},remainingBudget:r.budget===null ? null : {minorUnits:n(r.budget)-n(r.budget_committed),currency:'USD'},
    ...(r.linked_work_order_id ? {linkedWorkOrderId:r.linked_work_order_id as string} : {}),...(r.inventory_lot_id ? {sourceLotId:r.inventory_lot_id as string} : {}),
    recordVersion:n(r.record_version),orderRevision:n(r.revision),state:r.state as 'published'|'allocated',quantity:{value:n(r.quantity),unit:'each'},
    allocatedQuantity:{value:n(r.allocated_quantity),unit:'each'},remainingQuantity:{value:n(r.quantity)-n(r.allocated_quantity),unit:'each'},
    reportedQuantity:{value:n(totals.reported),unit:'each'},acknowledgedQuantity:{value:n(totals.acknowledged),unit:'each'},
    unitPrice:{minorUnits:n(r.unit_price),currency:'USD'},location:r.location as string,availableAt:iso(r.available_at),deliveryBy:iso(r.delivery_by),terms:r.terms as string,synthetic:true };
}
async function proposalView(client: PoolClient, r: Row): Promise<MarketProposal> {
  const approvals=(await client.query<Row>('SELECT * FROM market_approvals WHERE proposal_id=$1 ORDER BY side',[r.id])).rows;
  const commitment=(await client.query<Row>('SELECT id FROM market_commitments WHERE proposal_id=$1',[r.id])).rows[0];
  let state=r.state as MarketProposal['state'];
  if (state!=='committed') {
    const instant=await clock(client);
    if ((r.expires_at as Date).getTime()<=instant.getTime()) state='expired';
    else {
      const orders=await orderRows(client,[r.buy_order_id as string,r.sell_order_id as string]);
      if (orders.some(o => n(o.quantity)-n(o.allocated_quantity)<n(r.quantity))
        || orders.some(o => o.kind==='work_order' && product(r.quantity,r.unit_price)>n(o.budget)-n(o.budget_committed))) state='stale';
    }
  }
  return { proposalId:r.id as string,proposalRevision:n(r.revision),recordVersion:n(r.record_version),state,
    buyOrderId:r.buy_order_id as string,sellOrderId:r.sell_order_id as string,buyerOrganizationId:r.buyer_organization as string,sellerOrganizationId:r.seller_organization as string,
    quantity:{value:n(r.quantity),unit:'each'},unitPrice:{minorUnits:n(r.unit_price),currency:'USD'},expiresAt:iso(r.expires_at),
    buyOrderSnapshot:r.buy_snapshot as MarketOrder,sellOrderSnapshot:r.sell_snapshot as MarketOrder,
    buyerApproved:approvals.some(a => a.side==='buy'),sellerApproved:approvals.some(a => a.side==='sell'),
    ...(commitment ? {commitmentId:commitment.id as string} : {}),synthetic:true };
}
function fulfillmentView(r: Row): MarketFulfillment {
  return { fulfillmentId:r.id as string,quantity:{value:n(r.quantity),unit:'each'},...(r.note ? {note:r.note as string} : {}),reportedAt:iso(r.reported_at),
    acknowledged:r.acknowledged as boolean,...(r.acknowledged_at ? {acknowledgedAt:iso(r.acknowledged_at)} : {}),recordVersion:n(r.record_version) };
}
async function commitmentView(client: PoolClient, r: Row): Promise<MarketCommitment> {
  const p=await one(client,'SELECT * FROM market_proposals WHERE id=$1',[r.proposal_id]);
  const proposal=await proposalView(client,p);
  const reports=(await client.query<Row>('SELECT * FROM market_fulfillments WHERE commitment_id=$1 ORDER BY reported_at,id',[r.id])).rows;
  return { commitmentId:r.id as string,proposalId:r.proposal_id as string,proposalRevision:n(p.revision),recordVersion:n(r.record_version),state:r.state as MarketCommitment['state'],
    buyOrderId:proposal.buyOrderId,sellOrderId:proposal.sellOrderId,buyerOrganizationId:proposal.buyerOrganizationId,sellerOrganizationId:proposal.sellerOrganizationId,
    quantity:proposal.quantity,unitPrice:proposal.unitPrice,expiresAt:proposal.expiresAt,buyOrderSnapshot:proposal.buyOrderSnapshot,sellOrderSnapshot:proposal.sellOrderSnapshot,
    reportedQuantity:{value:n(r.reported_quantity),unit:'each'},acknowledgedQuantity:{value:n(r.acknowledged_quantity),unit:'each'},
    remainingQuantity:{value:n(r.quantity)-n(r.acknowledged_quantity),unit:'each'},fulfillmentReports:reports.map(fulfillmentView),committedAt:iso(r.committed_at),synthetic:true };
}
async function jobAttention(client:PoolClient,a:Authority,order:MarketOrder):Promise<MarketOrder>{
 if(!order.printRequirements || order.kind!=='work_order')return order;
 const rows=(await client.query<Row>('SELECT * FROM market_proposals WHERE buy_order_id=$1 AND (buyer_organization=$2 OR seller_organization=$2) ORDER BY id',[order.orderId,a.organization_id])).rows;
 let approvalCount=0,exceptionCount=0,waiting=false,authorizationNeeded=false;
 for(const row of rows){const linked=await orderRows(client,[row.buy_order_id as string,row.sell_order_id as string]);if(!linked.every(r=>permits(a,r)))continue;const p=await proposalView(client,row);if(['expired','stale'].includes(p.state))exceptionCount++;else if(p.state!=='committed'){if(!(a.organization_id===p.buyerOrganizationId?p.buyerApproved:p.sellerApproved)&&a.operations.includes('confirmMarketProposal')&&roleCommands[a.role]?.includes('confirmMarketProposal'))approvalCount++;else if(!(a.organization_id===p.buyerOrganizationId?p.buyerApproved:p.sellerApproved))authorizationNeeded=true;else waiting=true;}}
 const status=order.acknowledgedQuantity.value===order.quantity.value?'completed':order.reportedQuantity.value>order.acknowledgedQuantity.value?'receipt':order.allocatedQuantity.value>order.reportedQuantity.value?'fulfillment':approvalCount?'approval_required':exceptionCount?'blocked':authorizationNeeded?'authorization_needed':waiting?'waiting_counterparty':'awaiting_responses';
 const nextActor=status==='completed'?'none':status==='authorization_needed'?'authorized_approver':status==='approval_required'?'you':status==='receipt'?'receiver':status==='fulfillment'||status==='awaiting_responses'?'producer':'counterparty';
 return {...order,attention:{status,nextActor,approvalCount,exceptionCount}};
}
async function replayAccess(client: PoolClient,a: Authority,cached: Row): Promise<void> {
  await visibleOrders(client,a,cached.order_ids as string[]);
  if (cached.private) demand((cached.participant_organizations as string[]).includes(a.organization_id),'FORBIDDEN');
}
async function approvalsActive(client: PoolClient, auth: Authorities, p: Row, instant: Date): Promise<void> {
  const approvals=(await client.query<Row>('SELECT * FROM market_approvals WHERE proposal_id=$1 ORDER BY side',[p.id])).rows;
  demand(approvals.length===2,'FORBIDDEN');
  const orders=await orderRows(client,[p.buy_order_id as string,p.sell_order_id as string]);
  for (const approval of approvals) {
    const grant=auth.grants.get(approval.grant_id as string); demand(grant,'FORBIDDEN');
    const organization=approval.side==='buy' ? p.buyer_organization : p.seller_organization;
    demand(grant.actor_id===approval.actor_id && grant.organization_id===approval.organization_id && approval.organization_id===organization
      && n(approval.proposal_revision)===n(p.revision),'FORBIDDEN');
    active(grant,instant,'confirmMarketProposal'); orders.forEach(o => scope(grant,o));
  }
}
async function persist(client: PoolClient,context: Context,operation: string,input: CommandInput,receipt: Success,orders: Row[],organizations: string[],privateRecord: boolean): Promise<void> {
  const instant=await clock(client),eventId=randomUUID();
  const payload={schemaVersion:BASELINE,eventId,actorId:context.actorId,organizationId:context.organizationId,operation,happenedAt:instant.toISOString(),
    recordIds:receipt.recordIds,revisions:receipt.revisions,reason:operation,synthetic:true};
  await client.query(`INSERT INTO market_audit_events(id,actor_id,organization_id,operation,order_ids,participant_organizations,private,payload,happened_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[eventId,context.actorId,context.organizationId,operation,orders.map(o => o.id),organizations,privateRecord,payload,instant]);
  await client.query('INSERT INTO market_outbox(event_id) VALUES($1)',[eventId]);
  await client.query(`INSERT INTO market_idempotency(actor_id,organization_id,operation,key,fingerprint,order_ids,private,participant_organizations,result)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[context.actorId,context.organizationId,operation,input.idempotencyKey,fingerprint(input),orders.map(o => o.id),privateRecord,organizations,receipt]);
}
async function insertOrder(client: PoolClient,a: Authority,cmd: Input<'createMarketOrder'>,kind: MarketOrder['kind'],need: string|null,budget: number|null,linkedWorkOrderId: string|null=null,sourceLotId: string|null=null): Promise<Row> {
  const id=randomUUID();
  await client.query(`INSERT INTO market_orders(id,item_id,specification_revision,organization_id,actor_id,side,supply_mode,quantity,unit,unit_price,currency,location,available_at,delivery_by,terms,kind,need,budget,linked_work_order_id,inventory_lot_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,[id,cmd.itemId,cmd.specificationRevision,a.organization_id,a.actor_id,cmd.side,cmd.supplyMode ?? null,cmd.quantity.value,cmd.quantity.unit,
      cmd.unitPrice.minorUnits,cmd.unitPrice.currency,cmd.location,cmd.availableAt,cmd.deliveryBy,cmd.terms,kind,need,budget,linkedWorkOrderId,sourceLotId]);
  return (await orderRows(client,[id]))[0]!;
}
async function insertProposal(client: PoolClient,a: Authority,buy: Row,sell: Row,cmd: Pick<Input<'proposeMarketAllocation'>,'quantity'|'unitPrice'|'expiresAt'>): Promise<Row> {
  const id=randomUUID(),buySnapshot=await orderView(client,buy),sellSnapshot=await orderView(client,sell);
  await client.query(`INSERT INTO market_proposals(id,buy_order_id,sell_order_id,buyer_organization,seller_organization,actor_id,quantity,unit,unit_price,currency,expires_at,buy_snapshot,sell_snapshot)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,buy.id,sell.id,buy.organization_id,sell.organization_id,a.actor_id,cmd.quantity.value,cmd.quantity.unit,cmd.unitPrice.minorUnits,cmd.unitPrice.currency,cmd.expiresAt,buySnapshot,sellSnapshot]);
  return one(client,'SELECT * FROM market_proposals WHERE id=$1',[id]);
}
function materialLinkView(r: Row): MaterialSourceLink {
  return {linkId:r.id as string,workOrderId:r.work_order_id as string,materialListingId:r.material_listing_id as string,quantity:{value:n(r.quantity),unit:'each'},note:r.note as string,
    actorId:r.actor_id as string,organizationId:r.organization_id as string,createdAt:iso(r.created_at),synthetic:true,nonbinding:true};
}
async function workParticipant(client: PoolClient,a: Authority,work: Row): Promise<boolean> {
  return work.organization_id===a.organization_id || !!(await client.query('SELECT 1 FROM market_proposals WHERE buy_order_id=$1 AND seller_organization=$2 LIMIT 1',[work.id,a.organization_id])).rowCount;
}
function sourcingContext(client: PoolClient,a: Authority): SourcingContext {
  return {authority:a,visibleOrders:(ids,lock=false)=>visibleOrders(client,a,ids,lock),one:(sql,values=[])=>one(client,sql,values),clock:()=>clock(client),orderView:r=>orderView(client,r)};
}
export async function marketCommand(pool: pg.Pool,context: Context,operation: Command,input: CommandInput): Promise<Success> {
  for (let attempt=0;attempt<3;attempt++) {
    const client=await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL lock_timeout='250ms'"); await client.query("SET LOCAL statement_timeout='3s'");
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('vista-verde-local-backup',0))");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([context.actorId,context.organizationId,operation,input.idempotencyKey])]);
      const auth=await authority(client,context,operation,input),a=auth.current,sourcing=sourcingContext(client,a);
      await authorizeSourcingTarget(client,sourcing,operation,input);
      const cached=(await client.query<Row>(`SELECT * FROM market_idempotency WHERE actor_id=$1 AND organization_id=$2 AND operation=$3 AND key=$4`,
        [context.actorId,context.organizationId,operation,input.idempotencyKey])).rows[0];
      if (cached) {
        await replayAccess(client,a,cached); demand(cached.fingerprint===fingerprint(input),'IDEMPOTENCY_CONFLICT');
        active(a,await clock(client),operation); const receipt=success.parse(cached.result); await client.query('COMMIT'); return receipt;
      }
      let receipt: Success,orders: Row[],organizations: string[],privateRecord=true;
      const sourced=await sourcingCommand(client,sourcing,operation,input);
      if (sourced) { ({receipt,orders,organizations,privateRecord}=sourced); }
      else if (['createMarketOrder','postWorkOrder','postMaterialListing'].includes(operation)) {
        let cmd: Input<'createMarketOrder'>,need: string|null,budget: number|null;
        if (operation==='postWorkOrder') {
          const work=input as Input<'postWorkOrder'>;
          if(work.printRequirements){
            demand(a.market_scopes.includes('*'),'FORBIDDEN');
            const id=`PRINT-${randomUUID()}`;
            await client.query(`INSERT INTO market_items(id,specification_revision,name,description,specification_label,unit,specification) VALUES($1,1,'Mock print job','Fictional counted print. Metadata is a declaration, not engineering proof.','mock-print.v1','each',$2)`,[id,{kind:'mock-print-job',printRequirements:work.printRequirements}]);
            // Inline job creation requires an existing wildcard scope; no grant is widened.
            cmd={...work,itemId:id,side:'buy',unitPrice:{minorUnits:Math.floor(work.budget.minorUnits/work.quantity.value),currency:'USD'}};
          }else cmd={...work,side:'buy',unitPrice:{minorUnits:Math.floor(work.budget.minorUnits/work.quantity.value),currency:'USD'}};
          need=work.need; budget=work.budget.minorUnits;
        } else {
          cmd=operation==='postMaterialListing' ? {...input as Input<'postMaterialListing'>,side:'sell'} : input as Input<'createMarketOrder'>;
          need=cmd.side==='buy' ? `Synthetic counted ${cmd.itemId}` : null; budget=cmd.side==='buy' ? product(cmd.quantity.value,cmd.unitPrice.minorUnits) : null;
        }
        demand(a.market_scopes.includes('*') || a.market_scopes.includes(cmd.itemId),'FORBIDDEN');
        if(operation==='postMaterialListing' && cmd.itemId===PRINT_MATERIAL_ITEM){
          demand(cmd.specificationRevision===1,'MATCH_INVALID');
          await client.query(`INSERT INTO market_items(id,specification_revision,name,description,specification_label,unit,specification) VALUES($1,1,'Mock PETG spool','Fictional counted feedstock, no grams or yield conversion.','petg-synth-r1','each',$2) ON CONFLICT(id,specification_revision) DO NOTHING`,[PRINT_MATERIAL_ITEM,{synthetic:true,profile:'mock PETG / 1.75 mm',unit:'counted spool'}]);
        }
        const item=await one(client,'SELECT * FROM market_items WHERE id=$1 AND specification_revision=$2',[cmd.itemId,cmd.specificationRevision]);
        if(cmd.side==='buy' && (item.specification as Record<string,unknown>).kind==='mock-print-job')demand(operation==='postWorkOrder' && Boolean((input as Input<'postWorkOrder'>).printRequirements),'MATCH_INVALID');
        demand(item.unit===cmd.quantity.unit && Date.parse(cmd.deliveryBy)>=Date.parse(cmd.availableAt),'MATCH_INVALID');
        const sourceLotId=operation==='postMaterialListing' ? (input as Input<'postMaterialListing'>).sourceLotId ?? null : null;
        demand(!sourceLotId || cmd.supplyMode==='stock','MATCH_INVALID');
        const order=await insertOrder(client,a,cmd,cmd.side==='buy' ? 'work_order' : 'material_listing',need,budget,null,sourceLotId);
        const lot=sourceLotId ? await reserveInventoryForListing(client,a,order,sourceLotId) : null;
        orders=[order]; organizations=[a.organization_id]; privateRecord=false;
        receipt=result('published',{orderId:order.id as string,itemId:cmd.itemId,...(cmd.side==='buy' ? {workOrderId:order.id as string} : {materialListingId:order.id as string})},
          {order:json(await orderView(client,order)),...(lot ? {lot:json(lot)} : {})},{recordVersion:1,orderRevision:1,specificationRevision:cmd.specificationRevision},null,cmd.side==='buy' ? 'respond_to_work_order' : 'link_material_source');
      } else if (operation==='respondToWorkOrder') {
        const cmd=input as Input<'respondToWorkOrder'>,buy=(await visibleOrders(client,a,[cmd.workOrderId],true))[0]!;
        const requirements=(await orderView(client,buy)).printRequirements;
        if(requirements?.materialResponsibility==='customer')demand(cmd.acceptCustomerMaterial===true,'MATCH_INVALID');
        demand(buy.kind==='work_order' && buy.organization_id!==a.organization_id && buy.unit===cmd.quantity.unit
          && (buy.delivery_by as Date).getTime()>=Date.parse(cmd.availableAt),'MATCH_INVALID');
        demand(n(buy.record_version)===cmd.expectedRecordVersion,'REVISION_CONFLICT');
        demand(cmd.quantity.value<=n(buy.quantity)-n(buy.allocated_quantity),'ORDER_UNAVAILABLE');
        demand(Date.parse(cmd.expiresAt)>(await clock(client)).getTime(),'PROPOSAL_EXPIRED');
        const offer: Input<'createMarketOrder'>={...cmd,itemId:buy.item_id as string,specificationRevision:n(buy.specification_revision),side:'sell',terms:requirements?.materialResponsibility==='customer'?`${cmd.terms}\nProducer explicitly accepts declared customer material for mock-print.v1.`:cmd.terms};
        const sell=await insertOrder(client,a,offer,'capacity_offer',null,null,buy.id as string);
        const p=await insertProposal(client,a,buy,sell,cmd); orders=[buy,sell]; organizations=[buy.organization_id as string,a.organization_id];
        receipt=result('proposed',{orderId:sell.id as string,workOrderId:buy.id as string,buyOrderId:buy.id as string,sellOrderId:sell.id as string,proposalId:p.id as string},
          {order:json(await orderView(client,sell)),proposal:json(await proposalView(client,p))},{recordVersion:1,proposalRevision:1},'buyer_human','confirm_proposal');
      } else if (operation==='linkMaterialSource') {
        const cmd=input as Input<'linkMaterialSource'>;
        orders=await visibleOrders(client,a,[cmd.workOrderId,cmd.materialListingId],true);
        const work=orders.find(o => o.id===cmd.workOrderId)!,material=orders.find(o => o.id===cmd.materialListingId)!;
        demand(work.kind==='work_order' && material.kind==='material_listing' && material.unit===cmd.quantity.unit,'MATCH_INVALID');
        demand(await workParticipant(client,a,work),'FORBIDDEN');
        const id=randomUUID(),instant=await clock(client);
        await client.query('INSERT INTO market_material_links(id,work_order_id,material_listing_id,actor_id,organization_id,quantity,unit,note,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [id,work.id,material.id,a.actor_id,a.organization_id,cmd.quantity.value,cmd.quantity.unit,cmd.note,instant]);
        organizations=[...new Set([a.organization_id,work.organization_id as string])];
        const link=await one(client,'SELECT * FROM market_material_links WHERE id=$1',[id]);
        receipt=result('linked',{linkId:id,workOrderId:work.id as string,materialListingId:material.id as string},{materialSourceLink:json(materialLinkView(link))});
      } else if (operation==='proposeMarketAllocation') {
        const cmd=input as Input<'proposeMarketAllocation'>;
        orders=await visibleOrders(client,a,[cmd.buyOrderId,cmd.sellOrderId],true);
        const buy=orders.find(o => o.id===cmd.buyOrderId)!,sell=orders.find(o => o.id===cmd.sellOrderId)!;
        demand(buy.organization_id===a.organization_id || sell.organization_id===a.organization_id,'FORBIDDEN');
        if((await orderView(client,buy)).printRequirements?.materialResponsibility==='customer')demand(sell.kind==='capacity_offer' && sell.linked_work_order_id===buy.id,'MATCH_INVALID');
        demand(buy.kind==='work_order' && sell.side==='sell' && (sell.kind!=='capacity_offer' || sell.linked_work_order_id===buy.id) && buy.organization_id!==sell.organization_id && buy.item_id===sell.item_id
          && buy.specification_revision===sell.specification_revision && buy.unit===sell.unit && buy.unit===cmd.quantity.unit
          && buy.currency===sell.currency && buy.currency===cmd.unitPrice.currency
          && (sell.available_at as Date).getTime()<=(buy.delivery_by as Date).getTime(),'MATCH_INVALID');
        demand(n(buy.record_version)===cmd.expectedBuyVersion && n(sell.record_version)===cmd.expectedSellVersion,'REVISION_CONFLICT');
        demand(cmd.quantity.value<=n(buy.quantity)-n(buy.allocated_quantity) && cmd.quantity.value<=n(sell.quantity)-n(sell.allocated_quantity),'ORDER_UNAVAILABLE');
        demand(Date.parse(cmd.expiresAt)>(await clock(client)).getTime(),'PROPOSAL_EXPIRED');
        const p=await insertProposal(client,a,buy,sell,cmd); organizations=[buy.organization_id as string,sell.organization_id as string];
        receipt=result('proposed',{proposalId:p.id as string,buyOrderId:cmd.buyOrderId,sellOrderId:cmd.sellOrderId},{proposal:json(await proposalView(client,p))},{recordVersion:1,proposalRevision:1},'buyer_human','confirm_proposal');
      } else if (operation==='confirmMarketProposal') {
        const cmd=input as Input<'confirmMarketProposal'>;
        const p=await participantRecord(client,a,'market_proposals',cmd.proposalId,true);
        orders=await visibleOrders(client,a,[p.buy_order_id as string,p.sell_order_id as string],true);
        organizations=[p.buyer_organization as string,p.seller_organization as string];
        const buy=orders.find(o => o.id===p.buy_order_id)!,sell=orders.find(o => o.id===p.sell_order_id)!;
        demand(p.state!=='committed','ORDER_UNAVAILABLE');
        demand(n(p.record_version)===cmd.expectedRecordVersion,'REVISION_CONFLICT');
        const side=a.organization_id===p.buyer_organization ? 'buy' : 'sell';
        demand(!(await client.query('SELECT 1 FROM market_approvals WHERE proposal_id=$1 AND side=$2',[p.id,side])).rowCount,'REVISION_CONFLICT');
        const instant=await clock(client); active(a,instant,operation);
        demand((p.expires_at as Date).getTime()>instant.getTime(),'PROPOSAL_EXPIRED');
        demand((sell.available_at as Date).getTime()<=(buy.delivery_by as Date).getTime(),'MATCH_INVALID');
        const buySnapshot=p.buy_snapshot as MarketOrder,sellSnapshot=p.sell_snapshot as MarketOrder;
        demand(n(buy.revision)===buySnapshot.orderRevision && n(sell.revision)===sellSnapshot.orderRevision
          && n(buy.specification_revision)===buySnapshot.specificationRevision && n(sell.specification_revision)===sellSnapshot.specificationRevision,'REVISION_CONFLICT');
        demand(n(p.quantity)<=n(buy.quantity)-n(buy.allocated_quantity) && n(p.quantity)<=n(sell.quantity)-n(sell.allocated_quantity),'ORDER_UNAVAILABLE');
        await client.query('INSERT INTO market_approvals(proposal_id,side,proposal_revision,actor_id,organization_id,grant_id,approved_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [p.id,side,p.revision,a.actor_id,a.organization_id,a.id,instant]);
        const count=n((await one(client,'SELECT count(*) AS n FROM market_approvals WHERE proposal_id=$1',[p.id])).n);
        if (count===1) {
          await client.query("UPDATE market_proposals SET state='partially_approved',record_version=record_version+1 WHERE id=$1",[p.id]);
          const updated=await one(client,'SELECT * FROM market_proposals WHERE id=$1',[p.id]);
          receipt=result('partially_approved',{proposalId:p.id as string,buyOrderId:buy.id as string,sellOrderId:sell.id as string},{proposal:json(await proposalView(client,updated))},
            {recordVersion:n(updated.record_version),proposalRevision:n(p.revision)},side==='buy' ? 'producer' : 'buyer_human','confirm_proposal');
        } else {
          const finalInstant=await clock(client); demand((p.expires_at as Date).getTime()>finalInstant.getTime(),'PROPOSAL_EXPIRED');
          await approvalsActive(client,auth,p,finalInstant);
          if((await orderView(client,buy)).printRequirements?.materialResponsibility==='customer')demand(sell.kind==='capacity_offer' && sell.linked_work_order_id===buy.id,'MATCH_INVALID');
          const cost=product(p.quantity,p.unit_price);
          demand(cost<=n(buy.budget)-n(buy.budget_committed),'BUDGET_EXCEEDED');
          await allocateInventory(client,buy,sell,p,n(p.quantity));
          const id=randomUUID();
          await client.query(`INSERT INTO market_commitments(id,proposal_id,buy_order_id,sell_order_id,buyer_organization,seller_organization,quantity,unit,committed_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,p.id,buy.id,sell.id,p.buyer_organization,p.seller_organization,p.quantity,p.unit,finalInstant]);
          for (const order of orders) await client.query(`UPDATE market_orders SET allocated_quantity=allocated_quantity+$1,budget_committed=budget_committed+$3,record_version=record_version+1,
            state=CASE WHEN allocated_quantity+$1=quantity THEN 'allocated' ELSE 'published' END WHERE id=$2`,[p.quantity,order.id,order.kind==='work_order' ? cost : 0]);
          await client.query("UPDATE market_proposals SET state='committed',record_version=record_version+1 WHERE id=$1",[p.id]);
          const c=await one(client,'SELECT * FROM market_commitments WHERE id=$1',[id]);
          receipt=result('committed',{proposalId:p.id as string,commitmentId:id,buyOrderId:buy.id as string,sellOrderId:sell.id as string},
            {commitment:json(await commitmentView(client,c))},{recordVersion:1,proposalRevision:n(p.revision)},'producer','report_fulfillment');
        }
      } else if (operation==='reportMarketFulfillment') {
        const cmd=input as Input<'reportMarketFulfillment'>;
        const c=await participantRecord(client,a,'market_commitments',cmd.commitmentId,true);
        orders=await visibleOrders(client,a,[c.buy_order_id as string,c.sell_order_id as string]); organizations=[c.buyer_organization as string,c.seller_organization as string];
        demand(a.organization_id===c.seller_organization,'FORBIDDEN');
        demand(n(c.record_version)===cmd.expectedRecordVersion,'REVISION_CONFLICT');
        demand(cmd.quantity.unit===c.unit && safeTotal([n(c.reported_quantity),cmd.quantity.value])<=n(c.quantity),'FULFILLMENT_CONFLICT');
        const id=randomUUID(),instant=await clock(client);
        await client.query('INSERT INTO market_fulfillments(id,commitment_id,actor_id,quantity,unit,note,reported_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [id,c.id,a.actor_id,cmd.quantity.value,cmd.quantity.unit,cmd.note ?? null,instant]);
        await client.query("UPDATE market_commitments SET reported_quantity=reported_quantity+$1,record_version=record_version+1,state='in_progress' WHERE id=$2",[cmd.quantity.value,c.id]);
        const updated=await one(client,'SELECT * FROM market_commitments WHERE id=$1',[c.id]),f=await one(client,'SELECT * FROM market_fulfillments WHERE id=$1',[id]);
        receipt=result('in_progress',{commitmentId:c.id as string,fulfillmentId:id},{commitment:json(await commitmentView(client,updated)),fulfillment:json(fulfillmentView(f))},
          {recordVersion:n(updated.record_version),fulfillmentRecordVersion:1},'buyer_human','acknowledge_fulfillment');
      } else {
        const cmd=input as Input<'acknowledgeMarketFulfillment'>;
        const ref=await one(client,'SELECT * FROM market_fulfillments WHERE id=$1',[cmd.fulfillmentId]);
        const c=await participantRecord(client,a,'market_commitments',ref.commitment_id as string,true);
        const f=await one(client,'SELECT * FROM market_fulfillments WHERE id=$1 FOR UPDATE',[cmd.fulfillmentId]);
        orders=await visibleOrders(client,a,[c.buy_order_id as string,c.sell_order_id as string]); organizations=[c.buyer_organization as string,c.seller_organization as string];
        demand(a.organization_id===c.buyer_organization,'FORBIDDEN');
        demand(n(f.record_version)===cmd.expectedRecordVersion,'REVISION_CONFLICT');
        demand(!f.acknowledged && safeTotal([n(c.acknowledged_quantity),n(f.quantity)])<=n(c.reported_quantity)
          && safeTotal([n(c.acknowledged_quantity),n(f.quantity)])<=n(c.quantity),'FULFILLMENT_CONFLICT');
        const instant=await clock(client);
        await client.query('UPDATE market_fulfillments SET acknowledged=true,acknowledged_by=$1,acknowledged_at=$2,record_version=record_version+1 WHERE id=$3',[a.actor_id,instant,f.id]);
        await client.query(`UPDATE market_commitments SET acknowledged_quantity=acknowledged_quantity+$1,record_version=record_version+1,
          state=CASE WHEN acknowledged_quantity+$1=quantity THEN 'completed' ELSE 'in_progress' END WHERE id=$2`,[f.quantity,c.id]);
        const updated=await one(client,'SELECT * FROM market_commitments WHERE id=$1',[c.id]),updatedReport=await one(client,'SELECT * FROM market_fulfillments WHERE id=$1',[f.id]);
        const lot=await acknowledgeInventoryAcquisition(client,updated,updatedReport,a);
        receipt=result(updated.state as string,{commitmentId:c.id as string,fulfillmentId:f.id as string,...(lot ? {lotId:lot.lotId} : {})},
          {commitment:json(await commitmentView(client,updated)),fulfillment:json(fulfillmentView(updatedReport)),...(lot ? {lot:json(lot)} : {})},
          {recordVersion:n(updated.record_version),fulfillmentRecordVersion:n(updatedReport.record_version)},updated.state==='completed' ? null : 'producer',updated.state==='completed' ? null : 'report_fulfillment');
      }
      active(a,await clock(client),operation);
      await persist(client,context,operation,input,receipt,orders,organizations,privateRecord);
      // A delayed audit/outbox insertion must not carry expired counterparty
      // authority through the final commit. Grants/memberships remain locked.
      if (operation==='confirmMarketProposal' && receipt.state==='committed') {
        const p=await one(client,'SELECT * FROM market_proposals WHERE id=$1',[receipt.recordIds.proposalId]);
        const instant=await clock(client);
        demand((p.expires_at as Date).getTime()>instant.getTime(),'PROPOSAL_EXPIRED');
        await approvalsActive(client,auth,p,instant);
      }
      active(a,await clock(client),operation);
      await client.query('COMMIT'); return receipt;
    } catch (error) {
      await client.query('ROLLBACK');
      if (['40P01','40001','55P03','57014'].includes((error as {code?:string}).code ?? '')) {
        if (attempt<2) continue; throw new BusinessError('RETRYABLE_BUSY');
      }
      throw error;
    } finally { client.release(); }
  }
  throw new BusinessError('RETRYABLE_BUSY');
}

export async function marketQuery<O extends Operation>(pool: pg.Pool,context: Context,operation: O,input: Input<O>): Promise<Success> {
  const client=await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL lock_timeout='250ms'"); await client.query("SET LOCAL statement_timeout='3s'");
    const a=(await authority(client,context,operation)).current;
    const finish=async (receipt: Success) => { active(a,await clock(client),operation); await client.query('COMMIT'); return receipt; };
    const sourced=await sourcingQuery(client,sourcingContext(client,a),operation,input);
    if (sourced) return await finish(sourced);
    if (operation==='listWorkOrders' || operation==='listMaterialListings') {
      const filter=input as Input<'listWorkOrders'>;
      const kind=operation==='listWorkOrders' ? 'work_order' : 'material_listing';
      const rows=(await client.query<Row>(`SELECT o.* FROM market_orders o JOIN market_items i ON i.id=o.item_id AND i.specification_revision=o.specification_revision
        WHERE o.kind=$1 AND ($2::text IS NULL OR o.id>$2) AND ($3::text IS NULL OR strpos(lower(i.name||' '||o.item_id||' '||COALESCE(o.need,'')||' '||o.location),lower($3))>0)
        AND ('*'=ANY($4::text[]) OR o.id=ANY($4::text[]) OR o.item_id=ANY($4::text[])) AND (NOT $6::boolean OR i.specification->>'kind'='mock-print-job') ORDER BY o.id LIMIT $5`,[kind,filter.cursor ?? null,filter.search ?? null,a.market_scopes,filter.limit+1,filter.printOnly ?? false])).rows;
      const page=rows.slice(0,filter.limit),orders: MarketOrder[]=[];
      for (const r of page) orders.push(await jobAttention(client,a,await orderView(client,r)));
      return await finish(result('market',{}, {orders:json(orders),nextCursor:rows.length>filter.limit ? page.at(-1)!.id as string : null}));
    }
    if (operation==='listMarketItems') {
      const filter=input as Input<'listMarketItems'>;
      const rows=(await client.query<Row>(`SELECT i.* FROM (SELECT DISTINCT ON (id) * FROM market_items ORDER BY id,specification_revision DESC) i WHERE ($1::text IS NULL OR i.id>$1)
        AND ($2::text IS NULL OR strpos(lower(i.name||' '||i.description||' '||i.id),lower($2))>0)
        AND ('*'=ANY($3::text[]) OR i.id=ANY($3::text[]) OR EXISTS(SELECT 1 FROM market_orders o WHERE o.item_id=i.id AND o.id=ANY($3::text[])))
        ORDER BY i.id LIMIT $4`,[filter.cursor ?? null,filter.search ?? null,a.market_scopes,filter.limit+1])).rows;
      const page=rows.slice(0,filter.limit);
      return await finish(result('market',{}, {items:json(page.map(itemView)),nextCursor:rows.length>filter.limit ? page.at(-1)!.id as string : null}));
    }
    if (operation==='getMarketItem') {
      const filter=input as Input<'getMarketItem'>;
      const item=await one(client,'SELECT * FROM market_items WHERE id=$1 ORDER BY specification_revision DESC LIMIT 1',[filter.itemId]);
      demand(a.market_scopes.includes('*') || a.market_scopes.includes(filter.itemId)
        || (await client.query('SELECT 1 FROM market_orders WHERE item_id=$1 AND id=ANY($2::text[]) LIMIT 1',[filter.itemId,a.market_scopes])).rowCount,'FORBIDDEN');
      const rows=(await client.query<Row>(`SELECT * FROM market_orders WHERE kind<>'capacity_offer' AND item_id=$1 AND ($2::text IS NULL OR id>$2)
        AND ('*'=ANY($3::text[]) OR item_id=ANY($3::text[]) OR id=ANY($3::text[])) ORDER BY id LIMIT $4`,[filter.itemId,filter.cursor ?? null,a.market_scopes,filter.limit+1])).rows;
      const page=rows.slice(0,filter.limit),orders: MarketOrder[]=[];
      for (const r of page) orders.push(await orderView(client,r));
      return await finish(result('market',{itemId:filter.itemId},{item:json(itemView(item)),buyOrders:json(orders.filter(o => o.side==='buy')),
        sellOrders:json(orders.filter(o => o.side==='sell')),nextCursor:rows.length>filter.limit ? page.at(-1)!.id as string : null}));
    }
    if (operation==='getMarketOrder') {
      const id=(input as Input<'getMarketOrder'>).orderId,order=(await visibleOrders(client,a,[id]))[0]!;
      const links: MaterialSourceLink[]=[];
      if (order.kind==='work_order' && await workParticipant(client,a,order)) {
        const refs=(await client.query<Row>('SELECT * FROM market_material_links WHERE work_order_id=$1 ORDER BY id',[id])).rows;
        for (const ref of refs) {
          if (order.organization_id!==a.organization_id && ref.organization_id!==a.organization_id) continue;
          const material=(await orderRows(client,[ref.material_listing_id as string]))[0]!;
          if (permits(a,material)) links.push(materialLinkView(ref));
        }
      }
      return await finish(result(order.state as string,{orderId:id,itemId:order.item_id as string},{order:json(await orderView(client,order)),materialSourceLinks:json(links)},
        {recordVersion:n(order.record_version),orderRevision:n(order.revision),specificationRevision:n(order.specification_revision)},null,n(order.quantity)>n(order.allocated_quantity) ? order.kind==='work_order' ? 'respond_to_work_order' : 'link_material_source' : null));
    }
    if (operation==='getMarketProposal') {
      const id=(input as Input<'getMarketProposal'>).proposalId,p=await participantRecord(client,a,'market_proposals',id);
      const view=await proposalView(client,p);
      return await finish(result(view.state,{proposalId:id},{proposal:json(view)},{recordVersion:n(p.record_version),proposalRevision:n(p.revision)},
        ['committed','expired','stale'].includes(view.state) ? null : view.buyerApproved ? 'producer' : 'buyer_human',['committed','expired','stale'].includes(view.state) ? null : 'confirm_proposal'));
    }
    if (operation==='getMarketCommitment') {
      const id=(input as Input<'getMarketCommitment'>).commitmentId,c=await participantRecord(client,a,'market_commitments',id);
      const awaitingAcknowledgement=n(c.reported_quantity)>n(c.acknowledged_quantity);
      return await finish(result(c.state as string,{commitmentId:id,proposalId:c.proposal_id as string},{commitment:json(await commitmentView(client,c))},
        {recordVersion:n(c.record_version)},c.state==='completed' ? null : awaitingAcknowledgement ? 'buyer_human' : 'producer',
        c.state==='completed' ? null : awaitingAcknowledgement ? 'acknowledge_fulfillment' : 'report_fulfillment'));
    }
    if (operation==='getMarketWorkspace') {
      const filter=input as Input<'getMarketWorkspace'>;
      if (filter.workOrderId) await visibleOrders(client,a,[filter.workOrderId]);
      // One cursor pages a union of the organization's three collections. A
      // proposal/commitment is included only if both order scopes remain granted.
      const rows=(await client.query<Row>(`SELECT * FROM (
        SELECT 'order' AS kind,o.id FROM market_orders o WHERE o.organization_id=$1
          AND ('*'=ANY($2::text[]) OR o.id=ANY($2::text[]) OR o.item_id=ANY($2::text[]) OR (o.kind='capacity_offer' AND o.linked_work_order_id=ANY($2::text[])))
          AND ($5::text IS NULL OR o.id=$5 OR o.linked_work_order_id=$5)
        UNION ALL SELECT 'proposal',p.id FROM market_proposals p JOIN market_orders b ON b.id=p.buy_order_id JOIN market_orders s ON s.id=p.sell_order_id
          WHERE (p.buyer_organization=$1 OR p.seller_organization=$1) AND ($5::text IS NULL OR p.buy_order_id=$5 OR p.sell_order_id=$5)
          AND ('*'=ANY($2::text[]) OR b.id=ANY($2::text[]) OR b.item_id=ANY($2::text[]))
          AND ('*'=ANY($2::text[]) OR s.id=ANY($2::text[]) OR s.item_id=ANY($2::text[]) OR (s.kind='capacity_offer' AND s.linked_work_order_id=ANY($2::text[])))
        UNION ALL SELECT 'commitment',c.id FROM market_commitments c JOIN market_orders b ON b.id=c.buy_order_id JOIN market_orders s ON s.id=c.sell_order_id
          WHERE (c.buyer_organization=$1 OR c.seller_organization=$1) AND ($5::text IS NULL OR c.buy_order_id=$5 OR c.sell_order_id=$5)
          AND ('*'=ANY($2::text[]) OR b.id=ANY($2::text[]) OR b.item_id=ANY($2::text[]))
          AND ('*'=ANY($2::text[]) OR s.id=ANY($2::text[]) OR s.item_id=ANY($2::text[]) OR (s.kind='capacity_offer' AND s.linked_work_order_id=ANY($2::text[])))) records
        WHERE ($3::text IS NULL OR id>$3) ORDER BY id LIMIT $4`,[a.organization_id,a.market_scopes,filter.cursor ?? null,filter.limit+1,filter.workOrderId ?? null])).rows;
      const page=rows.slice(0,filter.limit),orders: MarketOrder[]=[],proposals: MarketProposal[]=[],commitments: MarketCommitment[]=[];
      for (const r of page) {
        if (r.kind==='order') orders.push(await orderView(client,await one(client,'SELECT * FROM market_orders WHERE id=$1',[r.id])));
        else if (r.kind==='proposal') proposals.push(await proposalView(client,await one(client,'SELECT * FROM market_proposals WHERE id=$1',[r.id])));
        else commitments.push(await commitmentView(client,await one(client,'SELECT * FROM market_commitments WHERE id=$1',[r.id])));
      }
      const can=(op: string) => a.operations.includes(op) && !!roleCommands[a.role]?.includes(op) && a.market_scopes.length>0;
      return await finish(result('market',{}, {actorId:a.actor_id,organizationId:a.organization_id,role:a.role,orders:json(orders),proposals:json(proposals),commitments:json(commitments),
        permissions:{canPost:can('createMarketOrder'),canPropose:can('proposeMarketAllocation'),canPostWorkOrder:can('postWorkOrder'),canPostMaterialListing:can('postMaterialListing'),canRespondToWorkOrder:can('respondToWorkOrder'),canLinkMaterialSource:can('linkMaterialSource'),canRecordMaterialUse:can('recordMaterialUse'),canLinkWorkStages:can('linkWorkStages'),canConfirm:can('confirmMarketProposal'),canReport:can('reportMarketFulfillment'),canAcknowledge:can('acknowledgeMarketFulfillment')},
        nextCursor:rows.length>filter.limit ? page.at(-1)!.id as string : null,synthetic:true}));
    }
    if (operation==='getHouseProject') {
      const id=(input as Input<'getHouseProject'>).projectId,project=await one(client,'SELECT * FROM market_projects WHERE id=$1',[id]);
      const whole=(await visibleOrders(client,a,[project.whole_house_order_id as string]))[0]!;
      const refs=(await client.query<Row>('SELECT order_id FROM market_project_orders WHERE project_id=$1 ORDER BY order_id',[id])).rows;
      const components=await visibleOrders(client,a,refs.map(r => r.order_id as string)),componentOrders: MarketOrder[]=[];
      for (const r of components) componentOrders.push(await orderView(client,r));
      return await finish(result('market',{projectId:id},{project:json({projectId:id,name:project.name,description:project.description,wholeHouseOrderId:whole.id,
        wholeHouseOrder:await orderView(client,whole),componentOrders,
        notice:'Manual references only; component receipts do not complete the house or establish engineering validity.',synthetic:true})}));
    }
    const filter=input as Input<'getMarketAudit'>;
    const order=(await client.query<Row>('SELECT * FROM market_orders WHERE id=$1',[filter.recordId])).rows[0];
    let ids: string[],directRecord: string|null=null;
    if (order) { await visibleOrders(client,a,[filter.recordId]); ids=[filter.recordId]; }
    else {
      const proposal=(await client.query<Row>('SELECT * FROM market_proposals WHERE id=$1',[filter.recordId])).rows[0];
      const commitment=(await client.query<Row>('SELECT * FROM market_commitments WHERE id=$1',[filter.recordId])).rows[0];
      if (proposal || commitment) {
        const r=(proposal ?? commitment)!; participant(a,r); ids=[r.buy_order_id as string,r.sell_order_id as string];
        await visibleOrders(client,a,ids); directRecord=filter.recordId;
      } else {
        const link=(await client.query<Row>('SELECT * FROM market_material_links WHERE id=$1',[filter.recordId])).rows[0];
        if (link) {
          await visibleOrders(client,a,[link.work_order_id as string,link.material_listing_id as string]);
          const referenced=(await orderRows(client,[link.work_order_id as string]))[0]!;
          demand(referenced.organization_id===a.organization_id || link.organization_id===a.organization_id,'FORBIDDEN');
          ids=[link.work_order_id as string,link.material_listing_id as string]; directRecord=filter.recordId;
        } else {
        const project=await one(client,'SELECT * FROM market_projects WHERE id=$1',[filter.recordId]);
        const refs=(await client.query<Row>('SELECT order_id FROM market_project_orders WHERE project_id=$1',[filter.recordId])).rows;
        ids=[project.whole_house_order_id as string,...refs.map(r => r.order_id as string)]; await visibleOrders(client,a,ids);
        }
      }
    }
    const events=(await client.query<Row>(`SELECT sequence,payload FROM market_audit_events a WHERE sequence>$1
      AND order_ids && $2::text[] AND (NOT private OR $3=ANY(participant_organizations))
      AND ($4::text IS NULL OR EXISTS(SELECT 1 FROM jsonb_each_text(payload->'recordIds') reference WHERE reference.value=$4))
      AND NOT EXISTS(SELECT 1 FROM unnest(a.order_ids) AS referenced(id) LEFT JOIN market_orders scoped_order ON scoped_order.id=referenced.id
        WHERE scoped_order.id IS NULL OR NOT ('*'=ANY($6::text[]) OR scoped_order.id=ANY($6::text[]) OR scoped_order.item_id=ANY($6::text[]) OR (scoped_order.kind='capacity_offer' AND scoped_order.linked_work_order_id=ANY($6::text[])))
        OR (scoped_order.kind='capacity_offer' AND scoped_order.organization_id<>$3 AND NOT EXISTS(SELECT 1 FROM market_orders work WHERE work.id=scoped_order.linked_work_order_id AND work.organization_id=$3)))
      ORDER BY sequence LIMIT $5`,[filter.cursor ?? '0',ids,a.organization_id,directRecord,filter.limit+1,a.market_scopes])).rows;
    const page=events.slice(0,filter.limit);
    return await finish(result('audit',{}, {events:json(page.map(e => e.payload)),nextCursor:events.length>filter.limit ? page.at(-1)!.sequence as string : null}));
  } catch (error) {
    await client.query('ROLLBACK');
    if (['40P01','40001','55P03','57014'].includes((error as {code?:string}).code ?? '')) throw new BusinessError('RETRYABLE_BUSY');
    throw error;
  } finally { client.release(); }
}
