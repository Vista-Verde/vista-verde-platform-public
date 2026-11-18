import { marketWorkspaceSchema,marketItemListSchema,marketItemDetailSchema,marketOrderListSchema,marketOrderDetailSchema,marketProposalSchema,marketCommitmentSchema,houseProjectSchema,marketAuditSchema,sourcingWorkspaceSchema } from '../../../packages/contracts/src/market.ts';
import type { MarketWorkspace,MarketItem,MarketItemDetailDTO,MarketOrder,MarketProposal,MarketCommitment,HouseProjectDTO,MarketAuditDTO,MaterialSourceLink,MaterialInventoryLot,SourcingWorkspaceDTO } from '../../../packages/contracts/src/market.ts';
import type { Session } from '../client.ts';
import { WebClient } from '../client.ts';
export const marketLink = (route:string,...ids:string[]) => '#'+[route,...ids.map(encodeURIComponent)].join('/');
export type MarketPage =
  | { kind:'producer-exchange' }
  | { kind:'print-demo' }
  | {kind:'route-demo'}
  | {kind:'print-intake'}
  | {kind:'activity';audit:MarketAuditDTO;recordId:string}
  | { kind:'market';book:MarketItemDetailDTO }
  | { kind:'work-orders';orders:MarketOrder[];nextCursor:string|null;search:string;printOnly?:boolean }
  | { kind:'materials';listings:MarketOrder[];nextCursor:string|null;search:string }
  | { kind:'work';workOrder:MarketOrder;materialSourceLinks:MaterialSourceLink[];materialListings:MarketOrder[];sourcesError?:string;audit?:MarketAuditDTO;auditError?:string }
  | { kind:'post-work';itemId?:string }
  | { kind:'post-material';itemId?:string;sourceLot?:MaterialInventoryLot }
  | { kind:'sourcing';sourcing:SourcingWorkspaceDTO;workOrders:MarketOrder[] }
  | { kind:'post';itemId?:string;side:'buy'|'sell' }
  | { kind:'orders' }
  | { kind:'order';order:MarketOrder }
  | { kind:'proposal';proposal:MarketProposal;audit?:MarketAuditDTO;auditError?:string }
  | { kind:'commitment';commitment:MarketCommitment;audit?:MarketAuditDTO;auditError?:string }
  | { kind:'house';project:HouseProjectDTO;sourcing?:SourcingWorkspaceDTO;sourcingError?:string };
export type MarketView = { key:string;csrf:string;workspace?:MarketWorkspace;items:MarketItem[];page?:MarketPage;error?:Error;partialErrors:string[] };
export async function loadMarketView(client:WebClient,session:Session,hash:string,key:string):Promise<MarketView> {
  let workspace:MarketWorkspace|undefined;
  let items:MarketItem[] = [];
  const partialErrors:string[] = [];
  try {
    const [path = '',query = ''] = hash.slice(1).split('?');
    const [route,id,side] = path.split('/').map(decodeURIComponent),parameters = new URLSearchParams(query),cursor = parameters.get('cursor') ?? undefined,search = parameters.get('search') ?? '';
    const [workspaceResult,itemResult] = await Promise.allSettled([
      client.call(session,'getMarketWorkspace',{ limit:100,...(route==='work' && id ? { workOrderId:id } : {}),...(route === 'orders' && cursor ? { cursor } : {}) }),client.call(session,'listMarketItems',{ limit:100 })
    ]);
    if (workspaceResult.status === 'rejected') throw workspaceResult.reason;
    workspace = marketWorkspaceSchema.parse(workspaceResult.value.data);
    if (['work','order'].includes(route ?? '') && id) {
      const visited=new Set<string>();
      while (workspace.nextCursor) {
        const next=workspace.nextCursor;
        if (visited.has(next)) throw new Error('The scoped record cursor did not advance. Refresh this job.');
        visited.add(next);
        const part=marketWorkspaceSchema.parse((await client.call(session,'getMarketWorkspace',{...(route==='work'?{workOrderId:id}:{}),limit:100,cursor:next})).data);
        workspace={...workspace,orders:[...workspace.orders,...part.orders],proposals:[...workspace.proposals,...part.proposals],commitments:[...workspace.commitments,...part.commitments],nextCursor:part.nextCursor};
      }
    }
    if (itemResult.status === 'fulfilled') items = marketItemListSchema.parse(itemResult.value.data).items;
    else partialErrors.push('Item names are unavailable. Records still show their stable item IDs.');
    const audit = async (recordId:string) => {
      try { return { audit:marketAuditSchema.parse((await client.call(session,'getMarketAudit',{ recordId,limit:20 })).data) }; }
      catch { return { auditError:'The audit trail is temporarily unavailable. The record can still be reviewed.' }; }
    };
    let page:MarketPage;
    if(route==='exchange')page={kind:'producer-exchange'};
    else if (route === 'print-demo') page = {kind:'print-demo'};
    else if(route==='route-demo')page={kind:'route-demo'};
    else if(route==='new-print')page={kind:'print-intake'};
    else if(route==='activity'&&id)page={kind:'activity',recordId:id,audit:marketAuditSchema.parse((await client.call(session,'getMarketAudit',{recordId:id,limit:20,...(cursor?{cursor}:{})})).data)};
    else if (route === 'post-work' || route === 'post' && !side) page = { kind:'post-work',itemId:id };
    else if (route === 'post-material') {
      let sourceLot:MaterialInventoryLot|undefined;
      if (side) {
        let sourcing = sourcingWorkspaceSchema.parse((await client.call(session,'getSourcingWorkspace',{ limit:100 })).data);
        sourceLot = sourcing.lots.find(lot => lot.lotId === side);
        const visited = new Set<string>();
        while (!sourceLot && sourcing.nextCursor && !visited.has(sourcing.nextCursor)) {
          visited.add(sourcing.nextCursor);
          sourcing = sourcingWorkspaceSchema.parse((await client.call(session,'getSourcingWorkspace',{ limit:100,cursor:sourcing.nextCursor })).data);
          sourceLot = sourcing.lots.find(lot => lot.lotId === side);
        }
        if (!sourceLot) throw new Error('The source inventory lot is unavailable to this participant. Return to inventory and review its current quantity.');
      }
      page = { kind:'post-material',itemId:id,sourceLot };
    }
    else if (route === 'post') page = { kind:'post',itemId:id,side:side === 'sell' ? 'sell' : 'buy' };
    else if (route === 'orders') page = { kind:'orders' };
    else if (['order','work'].includes(route ?? '') && id) {
      const detail = marketOrderDetailSchema.parse((await client.call(session,'getMarketOrder',{ orderId:id })).data);
      if (detail.order.kind === 'work_order') {
        let materialListings:MarketOrder[] = [],sourcesError:string|undefined;
        try { materialListings = marketOrderListSchema.parse((await client.call(session,'listMaterialListings',{ limit:100 })).data).orders; }
        catch { sourcesError = 'Independent supply candidates are temporarily unavailable. Your work order and shared responses remain visible.'; }
        page = { kind:'work',workOrder:detail.order,materialSourceLinks:detail.materialSourceLinks,materialListings,sourcesError,...await audit(id) };
      } else page = { kind:'order',order:detail.order };
    }
    else if (route === 'proposal' && id) page = { kind:'proposal',proposal:marketProposalSchema.parse((await client.call(session,'getMarketProposal',{ proposalId:id })).data.proposal),...await audit(id) };
    else if (route === 'commitment' && id) page = { kind:'commitment',commitment:marketCommitmentSchema.parse((await client.call(session,'getMarketCommitment',{ commitmentId:id })).data.commitment),...await audit(id) };
    else if (route === 'house') {
      const project = houseProjectSchema.parse((await client.call(session,'getHouseProject',{})).data.project);
      let sourcing:SourcingWorkspaceDTO|undefined,sourcingError:string|undefined;
      try { sourcing = sourcingWorkspaceSchema.parse((await client.call(session,'getSourcingWorkspace',{ limit:100 })).data); }
      catch { sourcingError = 'Your inventory and manual stage references are temporarily unavailable. House work-order progress remains visible.'; }
      page = { kind:'house',project,sourcing,sourcingError };
    } else if (route === 'sourcing') {
      const [sourceReply,orderReply] = await Promise.allSettled([client.call(session,'getSourcingWorkspace',{ limit:100,...(cursor ? { cursor } : {}) }),client.call(session,'listWorkOrders',{ limit:100 })]);
      if (sourceReply.status === 'rejected') throw sourceReply.reason;
      const workOrders = orderReply.status === 'fulfilled' ? marketOrderListSchema.parse(orderReply.value.data).orders : [];
      if (orderReply.status === 'rejected') partialErrors.push('The work-order choices for stage links are temporarily unavailable. Inventory quantities remain visible.');
      page = { kind:'sourcing',sourcing:sourcingWorkspaceSchema.parse(sourceReply.value.data),workOrders };
    } else if (route === 'materials'||!route) {
      const listing = marketOrderListSchema.parse((await client.call(session,'listMaterialListings',{ limit:100,...(cursor ? { cursor } : {}),...(search ? { search } : {}) })).data);
      page = { kind:'materials',listings:listing.orders,nextCursor:listing.nextCursor,search };
    } else if (route === 'market') {
      const itemId = route === 'market' && id ? id : items.find(item => item.itemId === 'HOUSE-KIT-DEMO')?.itemId ?? items[0]?.itemId;
      if (!itemId) throw new Error('There are no published items available in this demo.');
      page = { kind:'market',book:marketItemDetailSchema.parse((await client.call(session,'getMarketItem',{ itemId,limit:100,...(cursor ? { cursor } : {}) })).data) };
    } else {
      const board = marketOrderListSchema.parse((await client.call(session,'listWorkOrders',{ limit:100,...(route==='jobs'?{printOnly:true}:{}),...(cursor ? { cursor } : {}),...(search ? { search } : {}) })).data);
      page = { kind:'work-orders',orders:board.orders,nextCursor:board.nextCursor,search,...(route==='jobs'?{printOnly:true}:{}) };
    }
    return { key,csrf:session.csrf,workspace,items,page,partialErrors };
  } catch (error) { return { key,csrf:session.csrf,workspace,items,error:error as Error,partialErrors }; }
}
