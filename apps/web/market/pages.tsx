import {PrintIntake,PrintJobDetail} from './print-workspace.tsx';
import { useEffect,useState } from 'react';
import { marketItemListSchema } from '../../../packages/contracts/src/market.ts';
import type { MarketItem,MarketOrder,MarketProposal,MarketCommitment,MarketWorkspace,MarketAuditDTO,MarketItemDetailDTO,HouseProjectDTO,SourcingWorkspaceDTO } from '../../../packages/contracts/src/market.ts';
import type { Command } from '../../../packages/contracts/src/index.ts';
import type { Session } from '../client.ts';
import { WebClient } from '../client.ts';
import { MarketPanel,Stat,OrderTable,EmptyState,TermsReview,ProgressMeter,money,dateTime,shortId } from './components.tsx';
import type { MarketOrderRow } from './components.tsx';
import { OrderForm,AllocationForm,ApprovalForm,FulfillmentForm } from './forms.tsx';
import {ListingBrowser,orderRows} from './ListingBrowser.tsx';
import type {BrowseRow} from './ListingBrowser.tsx';
import { marketLink } from './model.ts';
import type { MarketPage } from './model.ts';
import { PrintDemo } from '../../print-demo/PrintDemo.tsx';
import {RouteDemo} from '../../print-demo/RouteDemo.tsx';
import { WorkOrderBoardView,MaterialListingsView,WorkOrderDetailView,WorkOrderPostingView,MaterialPostingView,MaterialListingDetailView,InventoryView } from './work-views.tsx';

export type MarketActions = { blocked:boolean;command:(operation:Command,input:Record<string,unknown>,label:string)=>void;refresh:()=>void;message:(text:string,error?:boolean)=>void };
const businessNames:Record<string,string> = { 'buyer-org':'Demo buyer','producer-a-org':'Supplier A','producer-b-org':'Supplier B','other-buyer-org':'Supplier C' };
export const business = (id:string) => businessNames[id] ?? id;
const itemName = (id:string,items:MarketItem[]) => items.find(item => item.itemId === id)?.name ?? id;
const glyph = (id:string) => id.includes('HOUSE') ? '⌂' : id.includes('PANEL') ? '▤' : id.includes('DOOR') ? '▯' : id.includes('ROOF') ? '⌑' : '◇';
const row = (order:MarketOrder):MarketOrderRow => ({ id:order.orderId,organizationId:order.organizationId,organizationName:business(order.organizationId),quantity:order.quantity,
  openQuantity:order.remainingQuantity.value,unitPrice:order.unitPrice,location:order.location,availableAt:order.availableAt,deliveryBy:order.deliveryBy,supplyMode:order.supplyMode,recordVersion:order.recordVersion });
const humanState = (state:string) => ({ proposed:'Awaiting approval',partially_approved:'One party approved',committed:'Committed',expired:'Expired',stale:'Stale terms',in_progress:'Partially fulfilled',completed:'Completed',published:'Open order',allocated:'Fully allocated' }[state] ?? state);

export function Catalog({ client,session,revision,selectedItemId }:{ client:WebClient;session:Session;revision:number;selectedItemId?:string }) {
  const [search,setSearch] = useState(''),[cursor,setCursor] = useState<string>();
  const [result,setResult] = useState<{key:string;items:MarketItem[];nextCursor:string|null;error?:string}>();
  const key = JSON.stringify([session.csrf,search,cursor,revision]),loading = result?.key !== key;
  useEffect(() => {
    let active = true;
    const timeout = setTimeout(() => {
      void client.call(session,'listMarketItems',{ limit:20,...(search.trim() ? { search:search.trim() } : {}),...(cursor ? { cursor } : {}) }).then(reply => {
        if (active) { const value = marketItemListSchema.parse(reply.data);setResult({ key,...value }); }
      }).catch(error => { if (active) setResult({ key,items:[],nextCursor:null,error:(error as Error).message }); });
    },search ? 180 : 0);
    return () => { active = false;clearTimeout(timeout); };
  },[client,session,key,search,cursor]);
  const items = result?.items ?? [];
  return <aside className="market-panel market-catalog" aria-label="Item catalog" aria-busy={loading}>
    <div className="market-catalog-heading"><p className="market-eyebrow">Physical goods</p><h2>Item catalog</h2>
      <label className="market-sr-only" htmlFor="market-search">Search items</label><div className="market-search"><span aria-hidden="true">⌕</span><input id="market-search" type="search" value={search} maxLength={200} placeholder="Search items or specs" onChange={event => { setSearch(event.target.value);setCursor(undefined); }}/></div>
    </div>
    {result?.error && !loading ? <div style={{ padding:'0 17px' }}><p role="alert" className="market-note error">{result.error}</p></div> : <>
      {loading && <p role="status" className="market-catalog-count">Searching the shared catalog…</p>}
      <ul className="market-item-list">{items.map(item => <li key={item.itemId}><a href={marketLink('market',item.itemId)} aria-current={selectedItemId === item.itemId ? 'true' : undefined}><span className="market-item-glyph" aria-hidden="true">{glyph(item.itemId)}</span><span><strong>{item.name}</strong><small>{item.specificationLabel} · {item.unit}</small></span></a></li>)}</ul>
      {!loading && !items.length && <EmptyState title="No matching items"><p>Try an item name, stable ID or specification label.</p></EmptyState>}
      <p className="market-catalog-count" role="status">{!loading && `${items.length} ${items.length === 1 ? 'item' : 'items'} shown · synthetic catalog`}</p>
      {result?.nextCursor && !loading && <div style={{ padding:'12px 17px 0' }}><button className="market-small" onClick={() => setCursor(result.nextCursor!)}>Next items</button></div>}
      {cursor && <div style={{ padding:'12px 17px 0' }}><button className="market-small market-quiet" onClick={() => setCursor(undefined)}>First items</button></div>}
    </>}
  </aside>;
}

export function MarketBookView({ book,workspace,actions }:{ book:MarketItemDetailDTO;workspace:MarketWorkspace;actions:MarketActions }) {
  const [buyId,setBuyId] = useState<string>(),[sellId,setSellId] = useState<string>();
  const buyOrder = book.buyOrders.find(order => order.orderId === buyId),sellOrder = book.sellOrders.find(order => order.orderId === sellId);
  const canPropose = workspace.permissions.canPropose && (buyOrder?.organizationId === workspace.organizationId || sellOrder?.organizationId === workspace.organizationId);
  const buyOpen = book.buyOrders.reduce((total,order) => total+BigInt(order.remainingQuantity.value),0n),sellOpen = book.sellOrders.reduce((total,order) => total+BigInt(order.remainingQuantity.value),0n);
  return <div className="market-stack">
    <section className="market-item-header"><div><p className="market-eyebrow">Item market / {book.item.itemId}</p><h2>{book.item.name}</h2><p>{book.item.description}</p><div className="market-spec"><span className="market-tag">{book.item.specificationLabel}</span><span className="market-tag">Revision {book.item.specificationRevision}</span><span className="market-tag">Unit: {book.item.unit}</span><span className="market-tag amber">Synthetic goods</span></div></div>
      <button className="market-primary" disabled={actions.blocked || !workspace.permissions.canPost} onClick={() => { window.location.hash = marketLink('post',book.item.itemId,'buy'); }}>Post order</button></section>
    <div className="market-stats"><Stat label="Open buy demand" value={`${buyOpen} each`} detail="Posted quantity still uncommitted"/><Stat label="Open sell supply" value={`${sellOpen} each`} detail="Stock and made-to-order offers"/><Stat label="Allocation flow" value="Explicit consent" detail="Proposals reserve no quantity"/></div>
    <OrderTable title="Buy demand" side="buy" orders={book.buyOrders.map(row)} selectedId={buyId} onSelect={setBuyId} ownOrganizationId={workspace.organizationId}/>
    <OrderTable title="Sell supply" side="sell" orders={book.sellOrders.map(row)} selectedId={sellId} onSelect={setSellId} ownOrganizationId={workspace.organizationId}/>
    <p className="market-book-help">Select one buy and one sell row to review a potential allocation. Your business must be a party to the proposal. Published supply is a disclosed offer.</p>
    {book.nextCursor && <a href={`${marketLink('market',book.item.itemId)}?cursor=${encodeURIComponent(book.nextCursor)}`}>Next order rows →</a>}
    <MarketPanel title="Propose an allocation" eyebrow="Step 2 / nonbinding">
      {buyOrder && sellOrder ? <><AllocationForm key={`${buyId}:${sellId}`} buyOrder={buyOrder} sellOrder={sellOrder} disabled={actions.blocked || !canPropose} onError={text => actions.message(text,true)} onSubmit={input => actions.command('proposeMarketAllocation',input,'Allocation proposed. Both businesses must review and confirm the frozen terms.')}/>{!canPropose && <p className="market-note warning" style={{ marginTop:16 }}>Select an order owned by your business and a counterparty’s order. The current participant’s grant must permit proposals.</p>}</> : <EmptyState title="Choose a buy and sell order"><p>Compare quantities, unit prices, origin, destination and deadlines above. You can propose a partial quantity after selecting both rows.</p></EmptyState>}
    </MarketPanel>
    <details className="market-panel"><summary>Basic specification and disclosed order terms</summary><p style={{ fontSize:11,marginTop:15 }}>Reference {book.item.itemId} · specification revision {book.item.specificationRevision}. These identifiers prevent silent substitution.</p><pre style={{ whiteSpace:'pre-wrap',fontSize:11,color:'#bacabd' }}>{JSON.stringify(book.item.specification,null,2)}</pre>
      {(buyOrder || sellOrder) && <TermsReview terms={[...(buyOrder ? [{ label:'Buy order terms',value:buyOrder.terms }] : []),...(sellOrder ? [{ label:'Sell order terms',value:sellOrder.terms }] : [])]}/>}</details>
  </div>;
}

function OwnWork({workspace,items,actions}:{workspace:MarketWorkspace;items:MarketItem[];actions:MarketActions}){
 const [search,setSearch]=useState('');
 const rows:BrowseRow[]=[...workspace.proposals.map(proposal=>({id:proposal.proposalId,title:(items.find(item=>item.itemId===proposal.buyOrderSnapshot.itemId)?.name??proposal.buyOrderSnapshot.itemId)+' · '+proposal.quantity.value+' each',itemId:proposal.buyOrderSnapshot.itemId,party:business(proposal.sellerOrganizationId),quantity:proposal.quantity.value,price:proposal.unitPrice,priceLabel:'USD per each',status:humanState(proposal.state),href:marketLink('proposal',proposal.proposalId),action:'Review proposal',description:proposal.buyOrderSnapshot.need??proposal.buyOrderSnapshot.terms,location:proposal.buyOrderSnapshot.location,deadline:proposal.expiresAt})),
 ...workspace.commitments.map(commitment=>({id:commitment.commitmentId,title:(items.find(item=>item.itemId===commitment.buyOrderSnapshot.itemId)?.name??commitment.buyOrderSnapshot.itemId)+' · '+commitment.quantity.value+' each',itemId:commitment.buyOrderSnapshot.itemId,party:business(commitment.sellerOrganizationId),quantity:commitment.remainingQuantity.value,price:commitment.unitPrice,priceLabel:'USD per each',status:humanState(commitment.state),href:marketLink('commitment',commitment.commitmentId),action:'Track order',description:commitment.buyOrderSnapshot.need??commitment.buyOrderSnapshot.terms,location:commitment.buyOrderSnapshot.location,deadline:commitment.buyOrderSnapshot.deliveryBy})),...orderRows(workspace.orders,items)];
 const filtered=rows.filter(row=>!search||[row.title,row.description,row.party,row.status,row.location].join(' ').toLowerCase().includes(search.toLowerCase()));
 return <ListingBrowser title="My orders" rows={filtered} items={items} search={search} onSearch={setSearch} blocked={actions.blocked||!workspace.permissions.canPostWorkOrder} post={{label:'Post work order',href:'#post-work'}} next={workspace.nextCursor?'#orders?cursor='+encodeURIComponent(workspace.nextCursor):undefined}>{window.location.hash.includes('cursor=')&&<a href="#orders">Return to first records</a>}</ListingBrowser>;
}

function OrderDetail({ order,items,workspace }:{ order:MarketOrder;items:MarketItem[];workspace:MarketWorkspace }) {
  return <div className="market-stack"><MarketPanel title={`${order.side === 'buy' ? 'Buy demand' : 'Sell supply'} / ${itemName(order.itemId,items)}`} eyebrow="Published order" action={<span className="market-tag">{humanState(order.state)}</span>}>
    <TermsReview terms={[
      { label:'Stable order ID',value:<code>{order.orderId}</code> },{ label:'Business',value:business(order.organizationId) },
      { label:'Specification',value:`${order.itemId} · revision ${order.specificationRevision} · each` },
      { label:'Quantity',value:`${order.remainingQuantity.value} open / ${order.quantity.value} posted each` },
      { label:'Unit price',value:`${money(order.unitPrice)} USD per each` },
      ...(order.side === 'sell' ? [{ label:'Supply mode',value:order.supplyMode === 'stock' ? 'In stock' : 'Made to order' }] : []),
      { label:'Location',value:order.location },{ label:'Availability',value:dateTime(order.availableAt) },{ label:'Delivery deadline',value:dateTime(order.deliveryBy) },
      { label:'Order terms',value:order.terms },{ label:'Record version',value:order.recordVersion }
    ]}/><div className="market-form-actions"><a href={marketLink('market',order.itemId)}>Compare this item’s buy and sell orders →</a></div>
  </MarketPanel><div className="market-stats"><Stat label="Confirmed allocation" value={`${order.allocatedQuantity.value} each`} detail="Completed commitments still consume allocation"/><Stat label="Seller reported" value={`${order.reportedQuantity.value} each`} detail="Awaiting separate receiver acknowledgement"/><Stat label="Receiver acknowledged" value={`${order.acknowledgedQuantity.value} each`} detail="Counted once toward fulfillment"/></div>
  {workspace.proposals.filter(proposal => proposal.buyOrderId === order.orderId || proposal.sellOrderId === order.orderId).map(proposal => <MarketPanel key={proposal.proposalId} title={`${proposal.quantity.value} each proposed`} action={<a href={marketLink('proposal',proposal.proposalId)}>Review frozen terms →</a>}><p>{humanState(proposal.state)} · {money(proposal.unitPrice)} per each</p></MarketPanel>)}
  {workspace.commitments.filter(commitment => commitment.buyOrderId === order.orderId || commitment.sellOrderId === order.orderId).map(commitment => <MarketPanel key={commitment.commitmentId} title={`${commitment.quantity.value} each committed`} action={<a href={marketLink('commitment',commitment.commitmentId)}>Track fulfillment →</a>}><ProgressMeter value={commitment.acknowledgedQuantity.value} total={commitment.quantity.value} label="Receiver acknowledged"/></MarketPanel>)}
  </div>;
}

function FrozenTerms({ record }:{ record:MarketProposal|MarketCommitment }) {
  const buy = record.buyOrderSnapshot,sell = record.sellOrderSnapshot;
  const committed = 'committedAt' in record;
  return <TermsReview description="These snapshots are immutable. Changes require a new proposal and renewed consent. Final confirmation checks current revisions and remaining quantities." terms={[
    ...(buy.printRequirements?[{label:'Immutable print requirements',value:`${buy.printRequirements.version} · ${buy.printRequirements.profile} · ${buy.printRequirements.mesh.bounds.join(' × ')} ${buy.printRequirements.mesh.units} · ${buy.printRequirements.mesh.triangles} triangles · ${buy.printRequirements.mesh.synthetic?'synthetic fixture':'declared local-file metadata'}`},{label:'Material responsibility',value:buy.printRequirements.materialResponsibility},{label:'Separate mock courier allowance',value:`${money(buy.printRequirements.delivery.allowance)} · fictional Zone ${buy.printRequirements.delivery.zone} · no booking/custody`}]:[]),
    { label:'Item / specification',value:`${buy.itemId} · revision ${buy.specificationRevision} · ${buy.quantity.unit}` },
    { label:'Buyer',value:business(record.buyerOrganizationId) },{ label:'Seller',value:business(record.sellerOrganizationId) },
    { label:committed ? 'Agreed allocation' : 'Proposed allocation',value:`${record.quantity.value} ${record.quantity.unit}` },{ label:committed ? 'Agreed unit price' : 'Proposed unit price',value:`${money(record.unitPrice)} USD per ${record.quantity.unit}` },
    { label:'Allocation value',value:money({ currency:'USD',minorUnits:record.unitPrice.minorUnits*record.quantity.value }) },
    ...(buy.kind === 'work_order' && buy.budget ? [{ label:'Buyer total stated budget',value:money(buy.budget) },{ label:'Budget available at proposal',value:buy.remainingBudget ? money(buy.remainingBudget) : 'Review buyer intent' }] : [{ label:'Posted unit prices',value:`Buy ${money(buy.unitPrice)} · sell ${money(sell.unitPrice)}` }]),
    { label:'Price scope',value:'Explicit all-in price for these goods. Separate input purchases are not added again.' },
    { label:'Origin → destination',value:`${sell.location} → ${buy.location}` },{ label:'Supply mode',value:sell.supplyMode === 'stock' ? 'In stock' : 'Made to order' },
    { label:'Supply availability',value:dateTime(sell.availableAt) },{ label:'Supply delivery limit',value:dateTime(sell.deliveryBy) },{ label:'Buyer availability',value:dateTime(buy.availableAt) },{ label:'Buyer deadline',value:dateTime(buy.deliveryBy) },
    { label:'Proposal expires',value:dateTime(record.expiresAt) },{ label:'Buyer order terms',value:buy.terms },{ label:'Seller order terms',value:sell.terms },
    { label:'Frozen revisions',value:`Buy v${buy.recordVersion} · sell v${sell.recordVersion} · proposal r${record.proposalRevision}` },
    { label:'Linked order IDs',value:<><code>{record.buyOrderId}</code><br/><code>{record.sellOrderId}</code></> }
  ]}/>;
}

function ProposalDetail({ proposal,workspace,items,actions,audit,auditError }:{ proposal:MarketProposal;workspace:MarketWorkspace;items:MarketItem[];actions:MarketActions;audit?:MarketAuditDTO;auditError?:string }) {
  const [now,setNow] = useState(() => Date.now());
  useEffect(() => {
    const timeout = setTimeout(() => setNow(Date.now()),Math.min(2147483647,Math.max(0,Date.parse(proposal.expiresAt)-Date.now()+1)));
    return () => clearTimeout(timeout);
  },[proposal.expiresAt]);
  const isBuyer = workspace.organizationId === proposal.buyerOrganizationId,isSeller = workspace.organizationId === proposal.sellerOrganizationId;
  const partyApproved = isBuyer ? proposal.buyerApproved : isSeller ? proposal.sellerApproved : false;
  const expired = Date.parse(proposal.expiresAt) <= now || proposal.state === 'expired',canApprove = workspace.permissions.canConfirm && (isBuyer || isSeller) && !partyApproved && !expired && !['committed','stale'].includes(proposal.state);
  return <div className="market-split"><div className="market-stack"><MarketPanel title={itemName(proposal.buyOrderSnapshot.itemId,items)} eyebrow="Proposal / frozen term review" action={<span className="market-tag amber">{humanState(proposal.state)}</span>}>
    <p className="market-record-id">{proposal.proposalId}</p><FrozenTerms record={proposal}/>
  </MarketPanel><AuditView audit={audit} error={auditError}/></div>
  <MarketPanel title="Explicit party confirmation" eyebrow="Step 3 / consent">
    <div className="market-progress-grid"><TermsReview terms={[{ label:'Buyer consent',value:proposal.buyerApproved ? 'Approved' : 'Awaiting approval' },{ label:'Seller consent',value:proposal.sellerApproved ? 'Approved' : 'Awaiting approval' },{ label:'You represent',value:`${business(workspace.organizationId)}${isBuyer ? ' · buyer' : isSeller ? ' · seller' : ''}` }]}/></div>
    {proposal.commitmentId ? <><p className="market-note">Both parties approved. Quantity is allocated in the shared commitment.</p><div className="market-form-actions"><a href={marketLink('commitment',proposal.commitmentId)}>Track commitment →</a></div></> : expired ? <p className="market-note warning">This proposal has expired. Create a new proposal with reviewed terms.</p> : proposal.state === 'stale' ? <p className="market-note warning">Current order revisions or quantities no longer support these terms. Review the market and propose again.</p> : partyApproved ? <p className="market-note">Your business has approved these terms. Waiting for the counterparty’s explicit approval.</p> : canApprove ? <><p className="market-note">Approving binds your business to these exact terms. The second party’s confirmation creates one commitment if current quantity and revisions still permit it.</p><ApprovalForm key={`${proposal.proposalId}:${proposal.recordVersion}`} disabled={actions.blocked} onApprove={() => actions.command('confirmMarketProposal',{ proposalId:proposal.proposalId,expectedRecordVersion:proposal.recordVersion },'Your party confirmation was recorded. Review the shared proposal status.')}/></> : <p className="market-note warning">This participant’s authenticated grant does not allow confirming these terms. Select the authorized human party.</p>}
    <div className="market-form-actions"><button className="market-small market-quiet" disabled={actions.blocked} onClick={actions.refresh}>Refresh status</button><a href={marketLink('work',proposal.buyOrderId)}>Review work order</a></div>
  </MarketPanel></div>;
}

function CommitmentDetail({ commitment,workspace,items,actions,audit,auditError }:{ commitment:MarketCommitment;workspace:MarketWorkspace;items:MarketItem[];actions:MarketActions;audit?:MarketAuditDTO;auditError?:string }) {
  const isSeller = commitment.sellerOrganizationId === workspace.organizationId,isBuyer = commitment.buyerOrganizationId === workspace.organizationId;
  return <div className="market-stack"><MarketPanel title={`${itemName(commitment.buyOrderSnapshot.itemId,items)} / ${commitment.quantity.value} each`} eyebrow="Confirmed commitment" action={<span className="market-tag">{humanState(commitment.state)}</span>}><p className="market-record-id">{commitment.commitmentId}</p><p style={{ fontSize:11 }}>Agreed {dateTime(commitment.committedAt)} · {business(commitment.sellerOrganizationId)} → {business(commitment.buyerOrganizationId)}</p><ProgressMeter value={commitment.acknowledgedQuantity.value} total={commitment.quantity.value} label="Receiver acknowledged"/></MarketPanel>
    <div className="market-stats"><Stat label="Agreed allocation" value={`${commitment.quantity.value} each`} detail="Consumes both orders, including when completed"/><Stat label="Seller reported" value={`${commitment.reportedQuantity.value} each`} detail={`${commitment.reportedQuantity.value-commitment.acknowledgedQuantity.value} each awaiting receiver acknowledgement`}/><Stat label="Remaining to acknowledge" value={`${commitment.remainingQuantity.value} each`} detail={`${commitment.acknowledgedQuantity.value} each acknowledged so far`}/></div>
    <div className="market-split"><MarketPanel title="Fulfillment reports" eyebrow="Step 4 / partial quantities">
      {!commitment.fulfillmentReports.length ? <EmptyState title="No fulfillment reported"><p>The seller can report all or part of the agreed quantity. The receiver acknowledges each report separately.</p></EmptyState> : <div className="market-list">{commitment.fulfillmentReports.map(report => <article className="market-record" key={report.fulfillmentId}>
        <div className="market-record-heading"><div><h3>{report.quantity.value} each reported</h3><p>{dateTime(report.reportedAt)} · {shortId(report.fulfillmentId)}</p></div><span className={`market-tag ${report.acknowledged ? '' : 'amber'}`}>{report.acknowledged ? 'Acknowledged' : 'Awaiting receiver'}</span></div>
        {report.note && <p style={{ fontSize:11 }}>{report.note}</p>}
        {report.acknowledged ? <p style={{ fontSize:10,marginBottom:0 }}>Acknowledged {report.acknowledgedAt ? dateTime(report.acknowledgedAt) : ''}. Counted once toward fulfillment.</p> : isBuyer && workspace.permissions.canAcknowledge ? <><p style={{ fontSize:11 }}>Acknowledge this report’s {report.quantity.value} each under the frozen demo terms.</p><button className="market-small market-primary" disabled={actions.blocked} onClick={() => actions.command('acknowledgeMarketFulfillment',{ fulfillmentId:report.fulfillmentId,expectedRecordVersion:report.recordVersion },`${report.quantity.value} each acknowledged under the demo terms.`)}>Acknowledge {report.quantity.value} each</button></> : <p style={{ fontSize:10,marginBottom:0 }}>The authorized receiver must acknowledge this report.</p>}
      </article>)}</div>}
    </MarketPanel><MarketPanel title={isSeller ? 'Report fulfillment' : 'Next required action'} eyebrow={isSeller ? 'Seller action' : 'Receiver action'}>
      {commitment.state === 'completed' ? <p className="market-note">The agreed quantity has been acknowledged. Allocation remains consumed. Completion under demo terms implies neither certification nor payment.</p> : isSeller && workspace.permissions.canReport ? <FulfillmentForm key={`${commitment.commitmentId}:${commitment.recordVersion}`} commitment={commitment} disabled={actions.blocked} onError={text => actions.message(text,true)} onSubmit={input => actions.command('reportMarketFulfillment',input,'Fulfillment reported. The receiver must acknowledge this quantity separately.')}/> : isBuyer ? <p className="market-note">Review seller reports, then acknowledge each delivered quantity under the agreed demo terms. Unreported quantity still requires a seller report.</p> : <p className="market-note warning">Only an authorized party can report or acknowledge fulfillment.</p>}
      <p style={{ fontSize:10,margin:'18px 0 0' }}>Reported and acknowledged quantities describe the same goods at different stages. They are never added together.</p>
    </MarketPanel></div>
    <details className="market-panel"><summary>Frozen agreement and linked order terms</summary><div style={{ marginTop:20 }}><FrozenTerms record={commitment}/></div></details><AuditView audit={audit} error={auditError}/>
  </div>;
}

function AuditView({ audit,error }:{ audit?:MarketAuditDTO;error?:string }) {
  return <details className="market-panel"><summary>Activity and technical details</summary><MarketPanel title="Attributable audit history">
    {error ? <p className="market-note warning" role="status">{error}</p> : !audit?.events.length ? <p style={{ fontSize:11,marginBottom:0 }}>No events visible to this participant yet.</p> : <><ol className="market-audit">{audit.events.map(event => <li key={event.eventId}><strong>{({ createMarketOrder:'Order posted',proposeMarketAllocation:'Allocation proposed',confirmMarketProposal:'Frozen terms confirmed',reportMarketFulfillment:'Fulfillment reported',acknowledgeMarketFulfillment:'Receiver acknowledged fulfillment' } as Record<string,string>)[event.operation] ?? event.operation}</strong><small>{event.actorId} · {business(event.organizationId)}<br/>{dateTime(event.happenedAt)}</small>{event.reason !== event.operation && <p style={{ margin:'5px 0 0',fontSize:10 }}>{event.reason}</p>}</li>)}</ol>{audit.nextCursor && <p className="market-note">Showing the first 20 events. Earlier history is available through the scoped audit API.</p>}</>}
  </MarketPanel></details>;
}

export function HouseProjectView({ project,items,sourcing,sourcingError }:{ project:HouseProjectDTO;items:MarketItem[];sourcing?:SourcingWorkspaceDTO;sourcingError?:string }) {
  const whole = project.wholeHouseOrder;
  return <div className="market-stack"><section className="market-project-hero"><div><p className="market-eyebrow">Manually linked project / {project.projectId}</p><h2>{project.name}</h2><p>{project.description}</p><span className="market-tag amber">Illustrative software story</span><div className="market-form-actions"><a href={marketLink('work',whole.orderId)}>Review the whole-house need →</a></div></div><div className="market-house-illustration" aria-hidden="true"><span/></div></section>
    <p className="market-note warning">{project.notice}</p>
    <MarketPanel title="Whole-house goal" eyebrow="Separate work order / separate budget"><div className="market-record-facts"><span><strong>{whole.quantity.value} each</strong>{itemName(whole.itemId,items)}</span><span><strong>{whole.budget ? money(whole.budget) : money(whole.unitPrice)}</strong>total synthetic stated budget</span><span><strong>{whole.location}</strong>By {dateTime(whole.deliveryBy)}</span></div><div className="market-progress-grid"><ProgressMeter value={whole.allocatedQuantity.value} total={whole.quantity.value} label="House kits committed"/><ProgressMeter value={whole.acknowledgedQuantity.value} total={whole.quantity.value} label="House kits acknowledged"/></div><p style={{ fontSize:11,marginBottom:0 }}>Component progress cannot create or complete this house commitment. The whole kit requires its own proposal, party confirmations and fulfillment.</p></MarketPanel>
    <div className="market-section-title"><h2>Manually linked component needs</h2><span className="market-tag">{project.componentOrders.length} independent demands</span></div>
    <div className="market-project-grid">{project.componentOrders.map(order => <MarketPanel className="market-project-card" key={order.orderId}><p className="market-eyebrow">{order.itemId}</p><h3>{itemName(order.itemId,items)}</h3><p>{order.quantity.value} each need · spec revision {order.specificationRevision}</p>{order.budget && <p>{money(order.budget)} total stated budget</p>}<ProgressMeter value={order.allocatedQuantity.value} total={order.quantity.value} label="Committed"/><ProgressMeter value={order.acknowledgedQuantity.value} total={order.quantity.value} label="Acknowledged"/><p>{order.remainingQuantity.value} each uncommitted · {order.allocatedQuantity.value-order.acknowledgedQuantity.value} each committed but unfulfilled</p><a href={marketLink('work',order.orderId)}>Review need and producer responses →</a></MarketPanel>)}</div>
    <MarketPanel title="Inputs and manually linked work stages" eyebrow="Separate procurement / producer outputs"><p style={{ fontSize:11 }}>An input supplier, an intermediate producer and the final buyer make their own explicit agreements. Each party states its budget; output prices remain all-in. Stage links group work for navigation.</p>{sourcingError && <p className="market-note warning" role="status">{sourcingError}</p>}{sourcing?.stageLinks.map(stage => <div className="manual-stage-flow" key={stage.linkId}><a href={marketLink('work',stage.upstreamWorkOrderId)}>{shortId(stage.upstreamWorkOrderId)}</a><span aria-hidden="true">→</span><a href={marketLink('work',stage.downstreamWorkOrderId)}>{shortId(stage.downstreamWorkOrderId)}</a><span className="market-tag amber">Manual reference</span></div>)}{sourcing && <p style={{ fontSize:11,marginTop:16 }}>{sourcing.lots.length} inventory {sourcing.lots.length === 1 ? 'lot' : 'lots'} visible to your business. Record input use and offer only its remaining available quantity with provenance.</p>}<div className="market-form-actions"><a href="#sourcing">Open inventory and manual stages →</a><a href="#materials">Browse independent inputs and outputs →</a></div></MarketPanel>
    <p className="market-note">These links group independent demands for navigation. Panels, doors and roof modules stay separate; their quantities are never summed into house completion.</p>
  </div>;
}

export function MarketPageView({ page,workspace,items,actions }:{ page:MarketPage;workspace:MarketWorkspace;items:MarketItem[];actions:MarketActions }) {
  if(page.kind==='print-intake')return <PrintIntake {...{workspace,actions}}/>;
  if(page.kind==='activity')return <div className="market-stack"><a href={marketLink('work',page.recordId)}>Back to job</a><AuditView audit={page.audit}/>{page.audit.nextCursor&&<a href={marketLink('activity',page.recordId)+'?cursor='+encodeURIComponent(page.audit.nextCursor)}>Next activity →</a>}</div>;
  if(page.kind==='producer-exchange')return <p>The producer service is unavailable in this workspace.</p>;
  if (page.kind === 'print-demo') return <PrintDemo/>;
  if(page.kind==='route-demo')return <RouteDemo canReview={workspace.permissions.canConfirm} blocked={actions.blocked}/>;
  const search = (route:string) => (value:string) => { window.location.hash = value ? `#${route}?${new URLSearchParams({ search:value }).toString()}` : `#${route}`; };
  if (page.kind === 'work-orders') return <WorkOrderBoardView {...page} items={items} workspace={workspace} actions={actions} onSearch={search(page.printOnly?'jobs':'work-orders')}/>;
  if (page.kind === 'materials') return <MaterialListingsView {...page} items={items} workspace={workspace} actions={actions} onSearch={search('materials')}/>;
  if(page.kind==='work'&&page.workOrder.printRequirements)return <PrintJobDetail {...page} {...{workspace,items,actions}}/>;
  if (page.kind === 'work') return <WorkOrderDetailView {...page} items={items} workspace={workspace} actions={actions}/>;
  if (page.kind === 'post-work') return <WorkOrderPostingView items={items} initialItemId={page.itemId} workspace={workspace} actions={actions}/>;
  if (page.kind === 'post-material') return <MaterialPostingView items={items} initialItemId={page.itemId} sourceLot={page.sourceLot} workspace={workspace} actions={actions}/>;
  if (page.kind === 'sourcing') return <InventoryView {...page} items={items} workspace={workspace} actions={actions}/>;
  if (page.kind === 'market') return <MarketBookView book={page.book} workspace={workspace} actions={actions}/>;
  if (page.kind === 'orders') return <OwnWork workspace={workspace} items={items} actions={actions}/>;
  if (page.kind === 'order') return page.order.kind === 'material_listing' ? <MaterialListingDetailView listing={page.order} workspace={workspace} items={items} actions={actions}/> : <OrderDetail order={page.order} workspace={workspace} items={items}/>;
  if (page.kind === 'proposal') return <ProposalDetail {...page} workspace={workspace} items={items} actions={actions}/>;
  if (page.kind === 'commitment') return <CommitmentDetail {...page} workspace={workspace} items={items} actions={actions}/>;
  if (page.kind === 'house') return <HouseProjectView {...page} items={items}/>;
  return <div className="market-split"><MarketPanel title="Post a market order" eyebrow="Step 1 / publish supply or demand">{items.length ? <OrderForm key={`${page.itemId}:${page.side}`} items={items} initialItemId={page.itemId} initialSide={page.side} disabled={actions.blocked || !workspace.permissions.canPost} onError={text => actions.message(text,true)} onSubmit={input => actions.command('createMarketOrder',input,'Market order posted. Propose an allocation separately when you find a compatible counterparty.')}/> : <EmptyState title="Item catalog unavailable"><p>Refresh to recover the current item references before posting.</p></EmptyState>}</MarketPanel><MarketPanel title="One business, both sides" eyebrow={business(workspace.organizationId)}><p style={{ fontSize:12 }}>Post a buy demand when your business needs an item. Post sell supply for stock or made-to-order goods. The item, specification, unit, price, location and timing remain explicit.</p><p className="market-note">All quantities, prices, locations, specifications and financial effects here are synthetic. A posting creates no reservation, commitment or payment.</p><div className="market-form-actions"><a href="#orders">View your buy and sell orders →</a></div></MarketPanel></div>;
}
