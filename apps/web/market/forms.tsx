import { useId,useState } from 'react';
import type { FormEvent } from 'react';
import type { MarketItem,MarketOrder,MarketCommitment } from '../../../packages/contracts/src/market.ts';
import { usd } from '../client.ts';
import { Field,TermsReview,money,dateTime } from './components.tsx';

type FormActions = { disabled:boolean;onSubmit:(input:Record<string,unknown>)=>void;onError:(message:string)=>void };
export function integer(value:FormDataEntryValue|null,label = 'Quantity'):number {
  const text = String(value ?? '');
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error(`${label} must be a positive whole number.`);
  return Number(text);
}
export function utc(value:FormDataEntryValue|null,label:string):string {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(text)) throw new Error(`Choose ${label} in UTC.`);
  const date = new Date(`${text}Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Choose a valid ${label}.`);
  return date.toISOString();
}
export const utcInput = (instant: string) => new Date(instant).toISOString().slice(0,16);
const future = (days:number) => utcInput(new Date(Date.now()+days*86400000).toISOString());
function submit(event:FormEvent<HTMLFormElement>,onError:FormActions['onError'],work:(data:FormData)=>void) {
  event.preventDefault();
  try { work(new FormData(event.currentTarget)); } catch (error) { onError((error as Error).message); }
}

export function OrderForm({ items,initialItemId,initialSide = 'buy',disabled,onSubmit,onError }:FormActions & { items:MarketItem[];initialItemId?:string;initialSide?:'buy'|'sell' }) {
  const prefix = useId();
  const [side,setSide] = useState(initialSide),[itemId,setItemId] = useState(initialItemId ?? items[0]?.itemId ?? '');
  const [dates] = useState(() => ({ available:future(0),deadline:future(7) }));
  const item = items.find(value => value.itemId === itemId);
  const field = (name:string) => `${prefix}-${name}`;
  return <form aria-label="Post market order" onSubmit={event => submit(event,onError,data => {
    if (disabled || !item) return;
    const availableAt = utc(data.get('availableAt'),'availability'),deliveryBy = utc(data.get('deliveryBy'),'delivery deadline');
    if (availableAt > deliveryBy) throw new Error('Delivery deadline must be at or after availability.');
    const quantity = integer(data.get('quantity')),minorUnits = usd(data.get('unitPrice'));
    if (minorUnits > Math.floor(Number.MAX_SAFE_INTEGER/quantity)) throw new Error('Quantity times unit price exceeds the supported amount.');
    onSubmit({ itemId:item.itemId,specificationRevision:item.specificationRevision,side,
      ...(side === 'sell' ? { supplyMode:String(data.get('supplyMode')) } : {}),quantity:{ value:quantity,unit:item.unit },
      unitPrice:{ minorUnits,currency:'USD' },location:String(data.get('location')).trim(),availableAt,deliveryBy,terms:String(data.get('terms')).trim() });
  })}>
    <div className="market-form-grid">
      <Field label="Item" name={field('item')}><select id={field('item')} name="itemId" value={itemId} disabled={disabled} onChange={event => setItemId(event.target.value)} required>{items.map(value => <option key={value.itemId} value={value.itemId}>{value.name} · {value.specificationLabel}</option>)}</select></Field>
      <Field label="Order side" name={field('side')}><select id={field('side')} name="side" value={side} disabled={disabled} onChange={event => setSide(event.target.value as 'buy'|'sell')}><option value="buy">Buy demand</option><option value="sell">Sell supply</option></select></Field>
      <Field label="Quantity (each)" name={field('quantity')} hint="Positive whole counts; compatible unit: each."><input id={field('quantity')} name="quantity" type="number" min="1" step="1" max={Number.MAX_SAFE_INTEGER} required disabled={disabled} defaultValue="1"/></Field>
      <Field label="Unit price (USD)" name={field('price')} hint="Synthetic USD per each, with at most two decimals."><input id={field('price')} name="unitPrice" type="number" min="0" step="0.01" required disabled={disabled} placeholder="100.00"/></Field>
      {side === 'sell' && <Field label="Supply mode" name={field('mode')}><select id={field('mode')} name="supplyMode" disabled={disabled}><option value="stock">In stock</option><option value="made_to_order">Made to order</option></select></Field>}
      <Field label="Location" name={field('location')} hint={side === 'buy' ? 'Synthetic delivery destination.' : 'Synthetic supply origin.'}><input id={field('location')} name="location" required maxLength={300} disabled={disabled} placeholder={side === 'buy' ? 'Demo site' : 'Demo yard'}/></Field>
      <Field label="Available from (UTC)" name={field('available')}><input id={field('available')} name="availableAt" type="datetime-local" required disabled={disabled} defaultValue={dates.available}/></Field>
      <Field label="Delivery deadline (UTC)" name={field('deadline')}><input id={field('deadline')} name="deliveryBy" type="datetime-local" required disabled={disabled} defaultValue={dates.deadline}/></Field>
    </div>
    <Field label="Order terms" name={field('terms')} hint="Basic explicit terms are frozen into any later proposal."><textarea id={field('terms')} name="terms" required minLength={1} maxLength={2000} disabled={disabled} rows={3} defaultValue="Synthetic demonstration only. Receiver acknowledges counted goods under these demo terms. No payment or quality certification."/></Field>
    {item && <p className="market-note">{item.itemId} · {item.specificationLabel} · specification revision {item.specificationRevision}. Posting makes an order visible; agreement requires a separate proposal and both parties’ confirmation.</p>}
    <div className="market-form-actions"><button className="market-primary" type="submit" disabled={disabled || !item}>Post {side} order</button><small>Saved safely before dispatch · Synthetic only</small></div>
  </form>;
}

export function AllocationForm({ buyOrder,sellOrder,disabled,onSubmit,onError }:FormActions & { buyOrder:MarketOrder;sellOrder:MarketOrder }) {
  const prefix = useId(),max = Math.min(buyOrder.remainingQuantity.value,sellOrder.remainingQuantity.value);
  const [expiresAt] = useState(() => future(1));
  const compatible = buyOrder.itemId === sellOrder.itemId && buyOrder.specificationRevision === sellOrder.specificationRevision && buyOrder.quantity.unit === sellOrder.quantity.unit;
  const sameBusiness = buyOrder.organizationId === sellOrder.organizationId;
  const timingCompatible = Date.parse(sellOrder.availableAt) <= Date.parse(buyOrder.deliveryBy);
  const field = (name:string) => `${prefix}-${name}`;
  return <form aria-label="Propose market allocation" onSubmit={event => submit(event,onError,data => {
    if (disabled || !compatible || sameBusiness || !timingCompatible || !max) return;
    const quantity = integer(data.get('quantity')),minorUnits = usd(data.get('unitPrice'));
    if (quantity > max) throw new Error(`At most ${max} each remain across these two orders. Refresh the book if quantities changed.`);
    if (minorUnits > Math.floor(Number.MAX_SAFE_INTEGER/quantity)) throw new Error('Quantity times unit price exceeds the supported amount.');
    if (buyOrder.remainingBudget && minorUnits*quantity > buyOrder.remainingBudget.minorUnits) throw new Error('The proposed total exceeds the work order’s remaining stated budget.');
    onSubmit({ buyOrderId:buyOrder.orderId,sellOrderId:sellOrder.orderId,expectedBuyVersion:buyOrder.recordVersion,expectedSellVersion:sellOrder.recordVersion,
      quantity:{ value:quantity,unit:'each' },unitPrice:{ minorUnits,currency:'USD' },expiresAt:utc(data.get('expiresAt'),'proposal expiry') });
  })}>
    <TermsReview terms={[
      { label:'Buyer',value:buyOrder.organizationId },{ label:'Seller',value:sellOrder.organizationId },
      { label:'Route',value:`${sellOrder.location} → ${buyOrder.location}` },
      { label:'Posted unit prices',value:`Buy ${money(buyOrder.unitPrice)} · sell ${money(sellOrder.unitPrice)}` },
      { label:'Supply availability',value:dateTime(sellOrder.availableAt) },
      { label:'Buyer deadline',value:dateTime(buyOrder.deliveryBy) }
    ]}/>
    {!compatible ? <p className="market-note error" role="alert">Item, specification revision and unit must match. This pair cannot be proposed.</p> : sameBusiness ? <p className="market-note warning">Choose a counterparty’s order. A business cannot make an agreement with itself.</p> : !timingCompatible ? <p className="market-note error" role="alert">Supply becomes available after the buyer’s delivery deadline. These orders cannot be allocated together.</p> : !max ? <p className="market-note warning">One of these orders has no open quantity. Select another pair or refresh.</p> : <>
      <div className="market-form-grid" style={{ marginTop:20 }}>
        <Field label="Proposed quantity (each)" name={field('quantity')} hint={`Up to ${max} each open. Proposing reserves none.`}><input id={field('quantity')} name="quantity" type="number" min="1" max={max} step="1" required disabled={disabled} defaultValue={max}/></Field>
        <Field label="Proposed unit price (USD)" name={field('price')} hint="Review a price explicitly, including any mismatch."><input id={field('price')} name="unitPrice" type="number" min="0" step="0.01" required disabled={disabled} defaultValue={(sellOrder.unitPrice.minorUnits/100).toFixed(2)}/></Field>
        <Field label="Proposal expires (UTC)" name={field('expires')}><input id={field('expires')} name="expiresAt" type="datetime-local" required disabled={disabled} defaultValue={expiresAt}/></Field>
      </div>
      {buyOrder.unitPrice.minorUnits !== sellOrder.unitPrice.minorUnits && <p className="market-note warning" style={{ marginTop:16 }}>Posted prices differ. Both businesses must explicitly agree to the proposed price.</p>}
      <div className="market-form-actions"><button className="market-primary" type="submit" disabled={disabled}>Propose allocation</button><small>Nonbinding · No quantity reserved</small></div>
    </>}
  </form>;
}

export function ApprovalForm({ disabled,onApprove }: { disabled:boolean;onApprove:()=>void }) {
  const id = useId();
  const [approved,setApproved] = useState(false);
  return <form aria-label="Confirm frozen proposal" onSubmit={event => { event.preventDefault();if (!disabled && approved) onApprove(); }}>
    <label className="market-check" htmlFor={id}><input id={id} type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} disabled={disabled} required/><span>I approve these frozen terms for my business.</span></label>
    <div className="market-form-actions"><button type="submit" className="market-primary" disabled={disabled || !approved}>Confirm frozen terms</button><small>Your authenticated grant determines which party you confirm.</small></div>
  </form>;
}

export function FulfillmentForm({ commitment,disabled,onSubmit,onError }:FormActions & { commitment:MarketCommitment }) {
  const prefix = useId(),max = commitment.quantity.value-commitment.reportedQuantity.value;
  return <form aria-label="Report partial fulfillment" onSubmit={event => submit(event,onError,data => {
    if (disabled || !max) return;
    const value = integer(data.get('quantity'));
    if (value > max) throw new Error(`At most ${max} each remain unreported.`);
    const note = String(data.get('note') ?? '').trim();
    onSubmit({ commitmentId:commitment.commitmentId,expectedRecordVersion:commitment.recordVersion,quantity:{ value,unit:'each' },...(note ? { note } : {}) });
  })}>
    <Field label="Report quantity (each)" name={`${prefix}-quantity`} hint={`${max} each not yet reported.`}><input id={`${prefix}-quantity`} name="quantity" type="number" min="1" max={max} step="1" defaultValue={Math.max(1,max)} required disabled={disabled || !max}/></Field>
    <Field label="Report note" name={`${prefix}-note`}><textarea id={`${prefix}-note`} name="note" rows={2} maxLength={1000} disabled={disabled || !max} placeholder="Synthetic delivery update"/></Field>
    <div className="market-form-actions"><button type="submit" className="market-primary" disabled={disabled || !max}>Report fulfillment</button><small>The receiver acknowledges separately.</small></div>
  </form>;
}
