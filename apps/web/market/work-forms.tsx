import { useId,useState } from 'react';
import type { FormEvent } from 'react';
import type { MarketItem,MarketOrder,MaterialInventoryLot } from '../../../packages/contracts/src/market.ts';
import {PRINT_MATERIAL_ITEM} from '../../../packages/contracts/src/market.ts';
import { usd } from '../client.ts';
import { Field,TermsReview,money,dateTime } from './components.tsx';
import { integer,utc,utcInput } from './forms.tsx';

type FormActions = { disabled:boolean;onSubmit:(input:Record<string,unknown>)=>void;onError:(message:string)=>void };
const future = (days:number) => utcInput(new Date(Date.now()+days*86400000).toISOString());
function submit(event:FormEvent<HTMLFormElement>,onError:FormActions['onError'],work:(data:FormData)=>void) {
  event.preventDefault();
  try { work(new FormData(event.currentTarget)); } catch (error) { onError((error as Error).message); }
}
function dates(data:FormData) {
  const availableAt = utc(data.get('availableAt'),'availability'),deliveryBy = utc(data.get('deliveryBy'),'delivery deadline');
  if (availableAt > deliveryBy) throw new Error('Delivery deadline must be at or after availability.');
  return { availableAt,deliveryBy };
}

export function WorkOrderForm({ items,initialItemId,disabled,onSubmit,onError }:FormActions & { items:MarketItem[];initialItemId?:string }) {
  const prefix = useId(),field = (name:string) => `${prefix}-${name}`;
  const [itemId,setItemId] = useState(initialItemId ?? items[0]?.itemId ?? '');
  const [initialDates] = useState(() => ({ available:future(0),deadline:future(7) }));
  const item = items.find(value => value.itemId === itemId);
  return <form aria-label="Post work order" onSubmit={event => submit(event,onError,data => {
    if (disabled || !item) return;
    onSubmit({ itemId:item.itemId,specificationRevision:item.specificationRevision,need:String(data.get('need')).trim(),
      quantity:{ value:integer(data.get('quantity')),unit:item.unit },budget:{ minorUnits:usd(data.get('budget')),currency:'USD' },
      location:String(data.get('location')).trim(),...dates(data),terms:String(data.get('terms')).trim() });
  })}>
    <Field label="Concrete need" name={field('need')} hint="Describe the goods you want a producer to supply."><textarea id={field('need')} name="need" rows={3} required maxLength={2000} disabled={disabled} placeholder="Produce 12 illustrative panels to the selected demo specification."/></Field>
    <div className="market-form-grid">
      <Field label="Item" name={field('item')}><select id={field('item')} name="itemId" value={itemId} disabled={disabled} onChange={event => setItemId(event.target.value)} required>{items.map(value => <option key={value.itemId} value={value.itemId}>{value.name} · {value.specificationLabel}</option>)}</select></Field>
      <Field label="Quantity (each)" name={field('quantity')} hint="Counted goods in the selected specification."><input id={field('quantity')} name="quantity" type="number" min="1" step="1" max={Number.MAX_SAFE_INTEGER} required disabled={disabled} defaultValue="1"/></Field>
      <Field label="Total budget (USD)" name={field('budget')} hint="Your total stated spending limit for this work order."><input id={field('budget')} name="budget" type="number" min="0" step="0.01" required disabled={disabled} placeholder="1200.00"/></Field>
      <Field label="Delivery location" name={field('location')}><input id={field('location')} name="location" required maxLength={300} disabled={disabled} placeholder="Demo site"/></Field>
      <Field label="Available from (UTC)" name={field('available')}><input id={field('available')} name="availableAt" type="datetime-local" required disabled={disabled} defaultValue={initialDates.available}/></Field>
      <Field label="Delivery deadline (UTC)" name={field('deadline')}><input id={field('deadline')} name="deliveryBy" type="datetime-local" required disabled={disabled} defaultValue={initialDates.deadline}/></Field>
    </div>
    <Field label="Work order terms" name={field('terms')} hint="State the terms producers should review before responding."><textarea id={field('terms')} name="terms" required maxLength={2000} disabled={disabled} rows={3} defaultValue="Synthetic counted goods only. Producer reports each fulfillment quantity; receiver acknowledges each report under the agreed terms. Material sourcing must be agreed explicitly."/></Field>
    {item && <p className="market-note">{item.itemId} · {item.specificationLabel} · specification revision {item.specificationRevision}. The budget is a stated intent and commitment limit. Posting does not prove funding or move money.</p>}
    <div className="market-form-actions"><button className="market-primary" type="submit" disabled={disabled || !item}>Post work order</button><small>Producers respond separately · Both parties confirm</small></div>
  </form>;
}

export function ProducerResponseForm({ workOrder,disabled,onSubmit,onError }:FormActions & { workOrder:MarketOrder }) {
  const prefix = useId(),field = (name:string) => `${prefix}-${name}`;
  const [initialDates] = useState(() => ({ available:future(0),deadline:utcInput(workOrder.deliveryBy),expires:future(1) }));
  const max = workOrder.remainingQuantity.value;
  return <form aria-label="Propose producer response" onSubmit={event => submit(event,onError,data => {
    if (disabled || !max) return;
    const value = integer(data.get('quantity')),minorUnits = usd(data.get('unitPrice')),timing = dates(data);
    if (value > max) throw new Error(`At most ${max} each remain open on this work order.`);
    if (minorUnits > Math.floor(Number.MAX_SAFE_INTEGER/value)) throw new Error('The response total exceeds the supported minor units.');
    if (workOrder.remainingBudget && minorUnits*value > workOrder.remainingBudget.minorUnits) throw new Error('The proposed response total exceeds this work order’s remaining stated budget.');
    if (Date.parse(timing.availableAt) > Date.parse(workOrder.deliveryBy)) throw new Error('The response becomes available after the work order’s delivery deadline.');
    onSubmit({ ...(data.get('acceptCustomerMaterial')==='on'?{acceptCustomerMaterial:true}:{}),workOrderId:workOrder.orderId,expectedRecordVersion:workOrder.recordVersion,quantity:{ value,unit:'each' },unitPrice:{ minorUnits,currency:'USD' },
      supplyMode:String(data.get('supplyMode')),location:String(data.get('location')).trim(),...timing,terms:String(data.get('terms')).trim(),expiresAt:utc(data.get('expiresAt'),'proposal expiry') });
  })}>
    <TermsReview terms={[{ label:'Open need',value:`${max} each` },{ label:'Remaining stated budget',value:workOrder.remainingBudget ? money(workOrder.remainingBudget) : 'Review work order budget' },{ label:'Destination',value:workOrder.location },{ label:'Buyer deadline',value:dateTime(workOrder.deliveryBy) }]}/>
    <div className="market-form-grid" style={{ marginTop:20 }}>
      <Field label="Response quantity (each)" name={field('quantity')} hint="You may respond to part of the need."><input id={field('quantity')} name="quantity" type="number" min="1" max={max} step="1" required disabled={disabled || !max} defaultValue={Math.max(1,max)}/></Field>
      <Field label="Response unit price (USD)" name={field('price')} hint="Explicit all-in output price. Quantity × unit price must fit the remaining stated budget."><input id={field('price')} name="unitPrice" type="number" min="0" step="0.01" required disabled={disabled || !max} placeholder="90.00"/></Field>
      <Field label="Supply mode" name={field('mode')}><select id={field('mode')} name="supplyMode" disabled={disabled || !max}><option value="made_to_order">Made to order</option><option value="stock">In stock</option></select></Field>
      <Field label="Response origin" name={field('origin')}><input id={field('origin')} name="location" required maxLength={300} disabled={disabled || !max} placeholder="Demo workshop"/></Field>
      <Field label="Available from (UTC)" name={field('available')}><input id={field('available')} name="availableAt" type="datetime-local" required disabled={disabled || !max} defaultValue={initialDates.available}/></Field>
      <Field label="Delivery deadline (UTC)" name={field('deadline')}><input id={field('deadline')} name="deliveryBy" type="datetime-local" required disabled={disabled || !max} defaultValue={initialDates.deadline}/></Field>
      <Field label="Proposal expires (UTC)" name={field('expires')}><input id={field('expires')} name="expiresAt" type="datetime-local" required disabled={disabled || !max} defaultValue={initialDates.expires}/></Field>
    </div>
    <Field label="Response terms" name={field('terms')} hint="Describe production and any material sourcing responsibility explicitly."><textarea id={field('terms')} name="terms" required maxLength={workOrder.printRequirements?.materialResponsibility==='customer'?1900:2000} rows={3} disabled={disabled || !max} defaultValue="Synthetic producer response. Counted goods under the referenced specification; buyer acknowledges reported quantities. Material sourcing and responsibility require explicit agreement."/></Field>
    {workOrder.printRequirements?.materialResponsibility==='customer'&&<label><input name="acceptCustomerMaterial" type="checkbox" required disabled={disabled}/>I explicitly accept the declared customer material for this fictional print response.</label>}
    <p className="market-note">This creates a private capacity offer and a nonbinding proposal. It does not publish a supply listing, reserve budget or approve either party’s terms.</p>
    <div className="market-form-actions"><button className="market-primary" type="submit" disabled={disabled || !max}>Propose producer response</button><small>Review frozen terms before confirming</small></div>
  </form>;
}

export function MaterialListingForm({ items,initialItemId,sourceLot,disabled,onSubmit,onError }:FormActions & { items:MarketItem[];initialItemId?:string;sourceLot?:MaterialInventoryLot }) {
  const prefix = useId(),field = (name:string) => `${prefix}-${name}`;
  const [itemId,setItemId] = useState(sourceLot?.itemId ?? initialItemId ?? items[0]?.itemId ?? '');
  const [initialDates] = useState(() => ({ available:future(0),deadline:future(7) }));
  const choices=items.some(i=>i.itemId===PRINT_MATERIAL_ITEM)?items:[...items,{itemId:PRINT_MATERIAL_ITEM,name:'Mock PETG spool',description:'Explicit synthetic supply listing only',specificationRevision:1,specificationLabel:'petg-synth-r1',unit:'each' as const,synthetic:true as const,specification:{synthetic:true}}];
  const item = choices.find(value => value.itemId === itemId);
  return <form aria-label="Post material listing" onSubmit={event => submit(event,onError,data => {
    if (disabled || !item) return;
    const value = integer(data.get('quantity')),minorUnits = usd(data.get('unitPrice'));
    if (minorUnits > Math.floor(Number.MAX_SAFE_INTEGER/value)) throw new Error('Quantity times unit price exceeds the supported amount.');
    if (sourceLot && value > sourceLot.availableQuantity.value) throw new Error('The listed quantity exceeds the inventory lot’s unoffered, unused quantity.');
    onSubmit({ itemId:item.itemId,specificationRevision:item.specificationRevision,quantity:{ value,unit:item.unit },unitPrice:{ minorUnits,currency:'USD' },supplyMode:sourceLot ? 'stock' : String(data.get('supplyMode')),
      ...(sourceLot ? { sourceLotId:sourceLot.lotId } : {}),location:String(data.get('location')).trim(),...dates(data),terms:String(data.get('terms')).trim() });
  })}>
    {sourceLot && <p className="market-note" style={{ marginBottom:18 }}>Relist from inventory lot <code>{sourceLot.lotId}</code>. {sourceLot.availableQuantity.value} each are available. Used, offered and allocated quantities cannot be listed again.</p>}
    <div className="market-form-grid">
      <Field label="Supply item" name={field('item')}><select id={field('item')} name="itemId" value={itemId} disabled={disabled || Boolean(sourceLot)} onChange={event => setItemId(event.target.value)} required>{choices.map(value => <option key={value.itemId} value={value.itemId}>{value.name} · {value.specificationLabel}</option>)}</select></Field>
      <Field label="Quantity (each)" name={field('quantity')}><input id={field('quantity')} name="quantity" type="number" min="1" step="1" max={sourceLot?.availableQuantity.value ?? Number.MAX_SAFE_INTEGER} required disabled={disabled} defaultValue="1"/></Field>
      <Field label="Unit price (USD)" name={field('price')} hint="Disclosed synthetic price per each."><input id={field('price')} name="unitPrice" type="number" min="0" step="0.01" required disabled={disabled} placeholder="25.00"/></Field>
      <Field label="Supply mode" name={field('mode')}><select id={field('mode')} name="supplyMode" disabled={disabled || Boolean(sourceLot)}><option value="stock">In stock</option><option value="made_to_order">Made to order</option></select></Field>
      <Field label="Supply location" name={field('location')}><input id={field('location')} name="location" required maxLength={300} disabled={disabled} placeholder="Demo supply yard"/></Field>
      <Field label="Available from (UTC)" name={field('available')}><input id={field('available')} name="availableAt" type="datetime-local" required disabled={disabled} defaultValue={initialDates.available}/></Field>
      <Field label="Delivery deadline (UTC)" name={field('deadline')}><input id={field('deadline')} name="deliveryBy" type="datetime-local" required disabled={disabled} defaultValue={initialDates.deadline}/></Field>
    </div>
    <Field label="Supply listing terms" name={field('terms')}><textarea id={field('terms')} name="terms" required maxLength={2000} disabled={disabled} rows={3} defaultValue="Synthetic supply listing for manual sourcing review. Availability is a disclosed offer; any purchase or responsibility requires separate explicit agreement."/></Field>
    <p className="market-note">Supply listings stand independently from work orders and may describe materials, components or other outputs. A source candidate is a manual reference; linking it does not buy or reserve goods.</p>
    <div className="market-form-actions"><button className="market-primary" type="submit" disabled={disabled || !item}>Post supply listing</button><small>Synthetic listing · Independent of a work order</small></div>
  </form>;
}

export function MaterialUseForm({ lot,disabled,onSubmit,onError }:FormActions & { lot:MaterialInventoryLot }) {
  const prefix = useId();
  return <form aria-label="Record material use" onSubmit={event => submit(event,onError,data => {
    if (disabled || !lot.availableQuantity.value) return;
    const value = integer(data.get('quantity'));
    if (value > lot.availableQuantity.value) throw new Error('Use cannot exceed this lot’s unoffered, unused quantity.');
    onSubmit({ lotId:lot.lotId,expectedRecordVersion:lot.recordVersion,quantity:{ value,unit:'each' },note:String(data.get('note')).trim() });
  })}>
    <Field label="Used quantity (each)" name={`${prefix}-quantity`} hint={`${lot.availableQuantity.value} each are available to use.`}><input id={`${prefix}-quantity`} name="quantity" type="number" min="1" max={lot.availableQuantity.value} step="1" required defaultValue="1" disabled={disabled || !lot.availableQuantity.value}/></Field>
    <Field label="Use note" name={`${prefix}-note`}><textarea id={`${prefix}-note`} name="note" required maxLength={1000} rows={2} disabled={disabled || !lot.availableQuantity.value} placeholder="Describe the manual use of this input for your work."/></Field>
    <div className="market-form-actions"><button type="submit" className="market-primary" disabled={disabled || !lot.availableQuantity.value}>Record material use</button><small>Explicit use · Available quantity decreases</small></div>
  </form>;
}

export function WorkStageForm({ orders,disabled,onSubmit,onError }:FormActions & { orders:MarketOrder[] }) {
  const prefix = useId();
  return <form aria-label="Link work stages manually" onSubmit={event => submit(event,onError,data => {
    if (disabled) return;
    const upstreamWorkOrderId = String(data.get('upstream')),downstreamWorkOrderId = String(data.get('downstream'));
    if (upstreamWorkOrderId === downstreamWorkOrderId) throw new Error('Choose two distinct work orders for a manual stage link.');
    onSubmit({ upstreamWorkOrderId,downstreamWorkOrderId,note:String(data.get('note')).trim() });
  })}>
    <div className="market-form-grid">
      <Field label="Upstream work order" name={`${prefix}-upstream`}><select id={`${prefix}-upstream`} name="upstream" disabled={disabled || orders.length < 2} required>{orders.map(order => <option key={order.orderId} value={order.orderId}>{order.itemId} · {order.need ?? order.orderId} · {shortLabel(order.orderId)}</option>)}</select></Field>
      <Field label="Downstream work order" name={`${prefix}-downstream`}><select id={`${prefix}-downstream`} name="downstream" disabled={disabled || orders.length < 2} defaultValue={orders[1]?.orderId} required>{orders.map(order => <option key={order.orderId} value={order.orderId}>{order.itemId} · {order.need ?? order.orderId} · {shortLabel(order.orderId)}</option>)}</select></Field>
    </div>
    <Field label="Stage link note" name={`${prefix}-note`}><textarea id={`${prefix}-note`} name="note" rows={2} required maxLength={1000} disabled={disabled || orders.length < 2} defaultValue="Manual stage reference for review. This link does not plan, procure or execute either stage."/></Field>
    <div className="market-form-actions"><button type="submit" className="market-primary" disabled={disabled || orders.length < 2}>Link work stages</button><small>Navigation reference · No automatic dependency</small></div>
  </form>;
}
const shortLabel = (id:string) => id.length > 24 ? `${id.slice(0,12)}…${id.slice(-5)}` : id;

export function MaterialSourceForm({ workOrder,listings,disabled,onSubmit,onError }:FormActions & { workOrder:MarketOrder;listings:MarketOrder[] }) {
  const prefix = useId(),field = (name:string) => `${prefix}-${name}`;
  const [listingId,setListingId] = useState(listings[0]?.orderId ?? '');
  const listing = listings.find(value => value.orderId === listingId);
  return <form aria-label="Link manual material source" onSubmit={event => submit(event,onError,data => {
    if (disabled || !listing) return;
    const value = integer(data.get('quantity'));
    if (value > listing.remainingQuantity.value) throw new Error('The candidate quantity exceeds the material listing’s currently disclosed open quantity.');
    onSubmit({ ...(data.get('acceptCustomerMaterial')==='on'?{acceptCustomerMaterial:true}:{}),workOrderId:workOrder.orderId,materialListingId:listing.orderId,quantity:{ value,unit:'each' },note:String(data.get('note')).trim() });
  })}>
    <Field label="Supply listing" name={field('listing')}><select id={field('listing')} name="materialListingId" value={listingId} disabled={disabled} onChange={event => setListingId(event.target.value)} required>{listings.map(value => <option key={value.orderId} value={value.orderId}>{value.itemId} · {value.location} · {value.remainingQuantity.value} each · {money(value.unitPrice)}</option>)}</select></Field>
    <Field label="Source quantity (each)" name={field('quantity')} hint="A candidate reference only; quantity is not reserved."><input id={field('quantity')} name="quantity" type="number" min="1" max={listing?.remainingQuantity.value} step="1" defaultValue="1" required disabled={disabled || !listing}/></Field>
    <Field label="Source note" name={field('note')}><textarea id={field('note')} name="note" required maxLength={1000} rows={2} disabled={disabled || !listing} defaultValue="Manual source candidate for review. No purchase, reservation or specification equivalence is implied."/></Field>
    <div className="market-form-actions"><button type="submit" className="market-primary" disabled={disabled || !listing}>Link supply candidate</button><small>Manual · Nonbinding</small></div>
  </form>;
}
