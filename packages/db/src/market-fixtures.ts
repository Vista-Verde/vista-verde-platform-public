import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { BASELINE, fingerprint } from '../../contracts/src/index.ts';
import type { Input, MarketOrder } from '../../contracts/src/index.ts';
import { result } from '../../domain/src/index.ts';
import { seedSourcingLots, seedSourcingRecords } from './work-sourcing.ts';

export const MARKET_FIXTURE = {
  projectId:'house-demo',houseItemId:'HOUSE-KIT-DEMO',panelItemId:'PANEL-DEMO',doorItemId:'DOOR-DEMO',roofItemId:'ROOF-MODULE-DEMO',
  houseBuyOrderId:'house-buy',houseSellOrderId:'house-sell',panelBuyOrderId:'panel-buy',panelSellAOrderId:'panel-sell-a',panelSellBOrderId:'panel-sell-b',
  doorBuyOrderId:'door-buy',doorSellOrderId:'door-sell-a',roofBuyOrderId:'roof-buy',roofSellOrderId:'roof-sell-b',producerABuyOrderId:'producer-a-buy'
} as const;
export async function seedMarketRecords(client: PoolClient): Promise<void> {
  const instant=(await client.query('SELECT clock_timestamp() AS instant')).rows[0].instant as Date;
  const at=(days: number) => new Date(instant.getTime()+days*86400000).toISOString();
  for (const [id,name,description,specification] of [
    ['HOUSE-KIT-DEMO','Illustrative house kit','Fabricated whole-house kit for the software story; no engineered design.',{kind:'demonstration house kit',scope:'placeholder identifying specification'}],
    ['PANEL-DEMO','Demo panel','Fabricated counted panel component.',{kind:'placeholder panel',material:'fictional composite',width:{value:100,unit:'cm'}}],
    ['DOOR-DEMO','Demo door','Fabricated counted door component.',{kind:'placeholder door',finish:'fictional plain'}],
    ['ROOF-MODULE-DEMO','Demo roof module','Fabricated counted roof component.',{kind:'placeholder roof module',material:'fictional composite'}],
    ['TIMBER-DEMO','Demo timber stock','Independent synthetic timber input; identifying labels do not establish building validity.',{kind:'placeholder timber stock',material:'fictional timber'}],
    ['FASTENER-DEMO','Demo fastener pack','Independent synthetic counted fastener input.',{kind:'placeholder fastener pack',material:'fictional metal'}],
    ['INSULATION-DEMO','Demo insulation pack','Independent synthetic counted insulation input.',{kind:'placeholder insulation pack',material:'fictional fibre'}]
  ] as const) await client.query(`INSERT INTO market_items(id,specification_revision,name,description,specification_label,unit,specification) VALUES($1,1,$2,$3,'demo-r1','each',$4)`,[id,name,description,specification]);
  await seedSourcingLots(client);
  const terms='Synthetic demo terms only. Seller reports counted quantities; buyer explicitly acknowledges each report. No stock guarantee, funds, settlement, quality certification or engineering claim.';
  const rows=[
    ['house-buy','HOUSE-KIT-DEMO','buyer','buyer-org','buy',null,1,10000000,'Demo site',0,45],
    ['house-sell','HOUSE-KIT-DEMO','producer-a','producer-a-org','sell','made_to_order',1,10500000,'Demo yard A',30,45],
    ['panel-buy','PANEL-DEMO','buyer','buyer-org','buy',null,12,10000,'Demo site',0,7],
    ['panel-sell-a','PANEL-DEMO','producer-a','producer-a-org','sell','stock',8,9000,'Demo yard A',0,7],
    ['panel-sell-b','PANEL-DEMO','producer-b','producer-b-org','sell','made_to_order',4,9500,'Demo yard B',3,7],
    ['door-buy','DOOR-DEMO','buyer','buyer-org','buy',null,2,20000,'Demo site',0,7],
    ['door-sell-a','DOOR-DEMO','producer-a','producer-a-org','sell','stock',2,20000,'Demo yard A',0,7],
    ['roof-buy','ROOF-MODULE-DEMO','buyer','buyer-org','buy',null,1,50000,'Demo site',0,10],
    ['roof-sell-b','ROOF-MODULE-DEMO','producer-b','producer-b-org','sell','made_to_order',1,48000,'Demo yard B',5,10],
    ['producer-a-buy','PANEL-DEMO','producer-a','producer-a-org','buy',null,1,8000,'Demo yard A',0,14],
    ['materialtimber-a','TIMBER-DEMO','producer-a','producer-a-org','sell','stock',12,100,'Demo yard A',0,14],
    ['materialfastener-a','FASTENER-DEMO','producer-a','producer-a-org','sell','stock',20,50,'Demo yard A',0,14],
    ['materialinsulation-b','INSULATION-DEMO','producer-b','producer-b-org','sell','stock',6,300,'Demo yard B',0,14],
    ['material-input-work-b','TIMBER-DEMO','producer-b','producer-b-org','buy',null,10,100,'Demo yard B',0,14]
  ] as const;
  for (const [id,item,actor,organization,side,supplyMode,quantity,price,location,available,deadline] of rows) {
    const input: Input<'createMarketOrder'>={idempotencyKey:`seed-${id}`,itemId:item,specificationRevision:1,side,...(supplyMode ? {supplyMode} : {}),quantity:{value:quantity,unit:'each'},
      unitPrice:{minorUnits:price,currency:'USD'},location,availableAt:at(available),deliveryBy:at(deadline),terms};
    const kind=side==='buy' ? 'work_order' : 'material_listing',need=side==='buy' ? `Synthetic need: ${quantity} counted ${item} at ${location}.` : null,budget=side==='buy' ? quantity*price : null;
    await client.query(`INSERT INTO market_orders(id,item_id,specification_revision,organization_id,actor_id,side,supply_mode,quantity,unit,unit_price,currency,location,available_at,delivery_by,terms,kind,need,budget,inventory_lot_id)
      VALUES($1,$2,1,$3,$4,$5,$6,$7,'each',$8,'USD',$9,$10,$11,$12,$13,$14,$15,$16)`,[id,item,organization,actor,side,supplyMode,quantity,price,location,input.availableAt,input.deliveryBy,terms,kind,need,budget,id==='materialtimber-a' ? 'timber-lot-a' : null]);
    const order: MarketOrder={orderId:id,itemId:item,specificationRevision:1,side,...(supplyMode ? {supplyMode} : {}),organizationId:organization,
      kind,need,...(id==='materialtimber-a' ? {sourceLotId:'timber-lot-a'} : {}),budget:budget===null ? null : {minorUnits:budget,currency:'USD'},budgetCommitted:budget===null ? null : {minorUnits:0,currency:'USD'},remainingBudget:budget===null ? null : {minorUnits:budget,currency:'USD'},
      recordVersion:1,orderRevision:1,state:'published',quantity:input.quantity,allocatedQuantity:{value:0,unit:'each'},remainingQuantity:input.quantity,
      reportedQuantity:{value:0,unit:'each'},acknowledgedQuantity:{value:0,unit:'each'},unitPrice:input.unitPrice,location,availableAt:input.availableAt,deliveryBy:input.deliveryBy,terms,synthetic:true};
    const receipt=result('published',{orderId:id,itemId:item},{order},{recordVersion:1,orderRevision:1,specificationRevision:1},null,'propose_allocation');
    const eventId=randomUUID(),payload={schemaVersion:BASELINE,eventId,actorId:actor,organizationId:organization,operation:'createMarketOrder',happenedAt:instant.toISOString(),
      recordIds:receipt.recordIds,revisions:receipt.revisions,reason:'seed_synthetic_fixture',synthetic:true};
    await client.query(`INSERT INTO market_audit_events(id,actor_id,organization_id,operation,order_ids,participant_organizations,private,payload,happened_at)
      VALUES($1,$2,$3,'createMarketOrder',$4,$5,false,$6,$7)`,[eventId,actor,organization,[id],[organization],payload,instant]);
    await client.query('INSERT INTO market_outbox(event_id) VALUES($1)',[eventId]);
    await client.query(`INSERT INTO market_idempotency(actor_id,organization_id,operation,key,fingerprint,order_ids,private,participant_organizations,result)
      VALUES($1,$2,'createMarketOrder',$3,$4,$5,false,$6,$7)`,[actor,organization,input.idempotencyKey,fingerprint(input),[id],[organization],receipt]);
  }
  await seedSourcingRecords(client);
  await client.query("INSERT INTO market_projects(id,name,description,whole_house_order_id) VALUES('house-demo','Illustrative house','Synthetic software demonstration with three manual component references; no calculated BOM or building validity.','house-buy')");
  for (const orderId of ['panel-buy','door-buy','roof-buy']) await client.query("INSERT INTO market_project_orders VALUES('house-demo',$1)",[orderId]);
}
export function marketOrder(key: string,itemId='PANEL-DEMO',side: 'buy'|'sell'='buy',quantity=1): Input<'createMarketOrder'> {
  return {idempotencyKey:key,itemId,specificationRevision:1,side,...(side==='sell' ? {supplyMode:'stock' as const} : {}),quantity:{value:quantity,unit:'each'},unitPrice:{minorUnits:10000,currency:'USD'},
    location:'Synthetic test site',availableAt:'2026-10-01T00:00:00.000Z',deliveryBy:'2027-01-01T00:00:00.000Z',terms:'Synthetic counted reports and explicit buyer acknowledgements; no financial effects.'};
}
export function marketProposal(buyOrderId: string,sellOrderId: string,quantity: number,key=`proposal-${randomUUID()}`,expectedBuyVersion=1,expectedSellVersion=1,price=9000): Input<'proposeMarketAllocation'> {
  return {idempotencyKey:key,buyOrderId,sellOrderId,expectedBuyVersion,expectedSellVersion,quantity:{value:quantity,unit:'each'},unitPrice:{minorUnits:price,currency:'USD'},expiresAt:new Date(Date.now()+3600000).toISOString()};
}
export function marketConfirmation(proposalId: string,expectedRecordVersion=1,key=`confirm-${randomUUID()}`): Input<'confirmMarketProposal'> {
  return {idempotencyKey:key,proposalId,expectedRecordVersion};
}
export function marketReport(commitmentId: string,quantity: number,expectedRecordVersion=1,key=`report-${randomUUID()}`): Input<'reportMarketFulfillment'> {
  return {idempotencyKey:key,commitmentId,expectedRecordVersion,quantity:{value:quantity,unit:'each'},note:'Synthetic fulfillment report.'};
}
export function marketAcknowledgement(fulfillmentId: string,expectedRecordVersion=1,key=`ack-${randomUUID()}`): Input<'acknowledgeMarketFulfillment'> {
  return {idempotencyKey:key,fulfillmentId,expectedRecordVersion};
}
