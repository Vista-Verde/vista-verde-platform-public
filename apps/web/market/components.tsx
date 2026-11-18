import { cloneElement,isValidElement,useId } from 'react';
import type { ReactNode } from 'react';

export type MarketOrderRow = {
  id:string; organizationId:string; organizationName?:string;
  quantity:{ value:number;unit:string }; openQuantity:number;
  unitPrice:{ minorUnits:number;currency:string }; location:string;
  availableAt:string;deliveryBy:string;supplyMode?:'stock'|'made_to_order';recordVersion:number;
};
export const money = (value:{ minorUnits:number;currency:string }) => new Intl.NumberFormat('en-US', {
  style:'currency',currency:value.currency,minimumFractionDigits:2,maximumFractionDigits:2
}).format(value.minorUnits/100);
export const dateTime = (instant:string) => {
  const date = new Date(instant);
  return Number.isNaN(date.getTime()) ? instant : `${new Intl.DateTimeFormat('en-US', {
    month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'UTC'
  }).format(date)} UTC`;
};
export const shortId = (id:string) => id.length > 23 ? `${id.slice(0,12)}…${id.slice(-7)}` : id;

export function MarketPanel({ title,eyebrow,action,children,className = '' }:{ title?:string;eyebrow?:string;action?:ReactNode;children:ReactNode;className?:string }) {
  return <section className={`market-panel ${className}`}>
    {(title || eyebrow || action) && <header className="market-panel-heading"><div>{eyebrow && <p className="market-eyebrow">{eyebrow}</p>}{title && <h2>{title}</h2>}</div>{action}</header>}
    {children}
  </section>;
}
export function Stat({ label,value,detail }:{ label:string;value:string|number;detail?:string }) {
  return <div className="market-stat"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;
}
export function Field({ label,name,children,hint }:{ label:string;name:string;children:ReactNode;hint?:string }) {
  const control = hint && isValidElement<{ 'aria-describedby'?:string }>(children) ? cloneElement(children,{
    'aria-describedby':[children.props['aria-describedby'],`${name}-hint`].filter(Boolean).join(' ')
  }) : children;
  return <div className="market-field"><label htmlFor={name}>{label}</label>{control}{hint && <small id={`${name}-hint`}>{hint}</small>}</div>;
}
export function EmptyState({ title,children,action }:{ title:string;children:ReactNode;action?:ReactNode }) {
  return <div className="market-empty"><span className="market-empty-mark" aria-hidden="true">◇</span><h3>{title}</h3><div>{children}</div>{action}</div>;
}
export function ProgressMeter({ value,total,label }:{ value:number;total:number;label:string }) {
  const id = useId();
  return <div className="market-progress"><div><span id={id}>{label}</span><strong>{value} / {total}</strong></div><progress aria-labelledby={id} max={Math.max(1,total)} value={Math.min(value,total)}/></div>;
}
export function TermsReview({ terms,description }:{ terms:{ label:string;value:ReactNode }[];description?:string }) {
  return <div className="market-terms">{description && <p>{description}</p>}<dl>{terms.map(term => <div key={term.label}><dt>{term.label}</dt><dd>{term.value}</dd></div>)}</dl></div>;
}
export function OrderTable({ title,side,orders,selectedId,onSelect,ownOrganizationId,empty }:{ title:string;side:'buy'|'sell';orders:MarketOrderRow[];selectedId?:string;onSelect?:(id:string)=>void;ownOrganizationId?:string;empty?:ReactNode }) {
  const id = useId();
  return <section className={`market-book market-book-${side}`} aria-labelledby={id}>
    <header><h3 id={id}><span className="market-side-dot"/>{title}</h3><span>{orders.length} {orders.length === 1 ? 'order' : 'orders'}</span></header>
    {!orders.length ? <EmptyState title={`No ${side === 'buy' ? 'buy demand' : 'sell supply'} yet`}>{empty ?? <p>Post an order for this item to start a comparison.</p>}</EmptyState> : <div className="market-table-scroll"><table>
      <caption className="market-sr-only">{title}. Choose an order to review a potential allocation.</caption>
      <thead><tr><th scope="col">{onSelect ? 'Choose / business' : 'Business'}</th><th scope="col">Open / posted</th><th scope="col">Unit price</th><th scope="col">Location</th><th scope="col">Available · deadline</th></tr></thead>
      <tbody>{orders.map(order => <tr key={order.id} data-order-id={order.id} className={order.id === selectedId ? 'is-selected' : ''}>
        <th scope="row">{onSelect ? <label className="market-order-choice"><input type="radio" name={`${side}-${id}`} checked={order.id === selectedId} onChange={() => onSelect(order.id)}/><span><strong>{order.organizationName ?? order.organizationId}</strong><small>{order.supplyMode ? order.supplyMode === 'stock' ? 'In stock' : 'Made to order' : 'Buy demand'}{order.organizationId === ownOrganizationId && ' · Your business'}</small></span></label> : <><strong>{order.organizationName ?? order.organizationId}</strong><small>{order.supplyMode === 'made_to_order' ? 'Made to order' : order.supplyMode === 'stock' ? 'In stock' : 'Buy demand'}</small></>}</th>
        <td className="market-numeric"><strong>{order.openQuantity} <span>{order.quantity.unit}</span></strong><small>of {order.quantity.value} posted</small></td>
        <td className="market-numeric"><strong>{money(order.unitPrice)}</strong><small>{order.unitPrice.currency} / {order.quantity.unit}</small></td>
        <td>{order.location}</td><td><time dateTime={order.availableAt}>{dateTime(order.availableAt)}</time><small>By {dateTime(order.deliveryBy)}</small></td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
