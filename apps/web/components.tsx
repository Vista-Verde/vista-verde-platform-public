import type { InputHTMLAttributes,ReactNode } from 'react';
import type { Workspace,WorkspaceRecord,SlotView } from '../../packages/contracts/src/views.ts';
import type { Session,Pending } from './client.ts';
import type { AuditEvent } from './model.ts';

export const money = (minor: number,currency = 'USD') => new Intl.NumberFormat('en-US',{ style:'currency',currency }).format(minor/100);
export const when = (time: string) => new Date(time).toLocaleString('en-US',{ dateStyle:'medium',timeStyle:'short',timeZone:'UTC' })+' UTC';
export const link = (route: string,...ids: string[]) => '#'+[route,...ids.map(encodeURIComponent)].join('/');
const human = (operation: string) => ({ createRequirementDraft:'Draft created by buyer agent',publishRequirement:'Slots published · compensation reserved',purchaseSlot:'Slot purchased · commitment recorded',withdrawUnpurchasedSlot:'Unpurchased slot withdrawn · hold released',processExpiredSlot:'Expired slot closed · hold released' }[operation] ?? operation);
export function Field({ label,name,...props }: InputHTMLAttributes<HTMLInputElement> & { label:string;name:string }) {
  return <div className="field"><label htmlFor={name}>{label}</label><input id={name} name={name} required {...props}/></div>;
}
export function Empty({ title,children }: { title:string;children:ReactNode }) {
  return <div className="empty"><h3>{title}</h3><p>{children}</p></div>;
}
type SessionControlsProps = { session:Session;blocked:boolean;onSwitch:(persona?:string)=>void };
type RecoveryProps = { blocked:boolean;pending?:Pending;recoveryError?:string;onRetry:()=>void };
function SessionControls({ session,blocked,onSwitch }: SessionControlsProps) {
  return <div className="persona"><label htmlFor="persona">Demo role</label><select id="persona" value={session.persona ?? ''} disabled={blocked} onChange={event => onSwitch(event.target.value)}>
    {session.personas.map(persona => <option key={persona.id} value={persona.id}>{persona.label}</option>)}
  </select><small>Local fixture selector · Not production authentication</small><button id="logout" className="quiet" disabled={blocked} onClick={() => onSwitch()}>End demo session</button></div>;
}
function RecoveryNotice({ blocked,pending,recoveryError,onRetry }: RecoveryProps) {
  return <>
    {pending && <div className="note warning"><strong>A saved request needs recovery.</strong> Its original terms and retry key are retained in this tab. <button id="retry" disabled={blocked} onClick={onRetry}>Retry saved request</button></div>}
    {recoveryError && <div className="note warning">{recoveryError} Commands are paused to preserve any earlier intent.</div>}
  </>;
}
export function SessionRecovery(props: SessionControlsProps & RecoveryProps) {
  return <>
    <section className="hero"><div><p className="eyebrow">Demo session / Manufacturing</p><h1>Workspace access</h1><p>Select an available demo role or end this session.</p></div><SessionControls {...props}/></section>
    <RecoveryNotice {...props}/>
  </>;
}
export function WorkspaceHeader({ workspace,session,hash,blocked,pending,recoveryError,onSwitch,onRetry }:
  { workspace:Workspace;session:Session;hash:string;blocked:boolean;pending?:Pending;recoveryError?:string;onSwitch:(persona?:string)=>void;onRetry:()=>void }) {
  const producer = workspace.role === 'producer';
  return <>
    <section className="hero"><div><p className="eyebrow">{producer ? 'Producer workspace' : 'Buyer workspace'} / Manufacturing</p>
      <h1>{producer ? 'Make what’s needed.' : 'From demand to production.'}</h1>
      <p>{producer ? 'Review released specifications, choose an eligible allocation, and keep the commitment in view.' : 'Turn agent-created requirements into funded synthetic allocations. Review the terms before releasing work.'}</p></div>
      <SessionControls session={session} blocked={blocked} onSwitch={onSwitch}/>
    </section>
    <section className="metrics" aria-label="Your synthetic funds">
      <div className="metric"><span className="label">Available synthetic funds</span><strong>{money(workspace.funds.availableMinorUnits,workspace.funds.currency)}</strong><small>Only your organization’s balance</small></div>
      <div className="metric"><span className="label">Reserved compensation</span><strong>{money(workspace.funds.reservedMinorUnits,workspace.funds.currency)}</strong><small>{producer ? 'Your own account holds' : 'Across all published requirements'}</small></div>
      <div className="metric"><span className="label">Workspace mode</span><strong>Synthetic</strong><small>Reviewed test references · No live payments</small></div>
    </section>
    <nav className="tabs" aria-label="Workspace">
      <a href="#" aria-current={!hash || hash === '#' ? 'page' : undefined}>{producer ? 'Available slots' : 'Requirements'}</a>
      {producer && <a href="#commitments" aria-current={hash === '#commitments' ? 'page' : undefined}>Your commitments</a>}
      {workspace.role === 'buyer_agent' && <a href="#draft" aria-current={hash === '#draft' ? 'page' : undefined}>Create draft</a>}
    </nav>
    <RecoveryNotice blocked={blocked} pending={pending} recoveryError={recoveryError} onRetry={onRetry}/>
  </>;
}
export function RecordCards({ records }: { records:WorkspaceRecord[] }) {
  return <>{records.map(record => <article key={record.id} className="card">
    <div className="card-top"><span className="eyebrow">{record.receipt ? 'Producer commitment' : `Requirement / revision ${record.requirementRevision}`}</span><span className={`tag ${record.state === 'draft' ? 'draft' : ''}`}>{record.receipt ? 'Purchased' : record.state}</span></div>
    <h3>{record.title}</h3><p>{record.receipt ? 'Allocation recorded. Capacity confirmation and fulfillment remain pending.' : record.state === 'draft' ? 'Awaiting human review, complete terms and synthetic funding reservation.' : `${record.slotCount} fixed allocation${record.slotCount === 1 ? '' : 's'} · Publication reserved full compensation.`}</p><div className="card-bottom"><span className="record-id">{record.id.slice(0,8)}…</span>
      <a href={link(record.receipt ? 'commitment' : 'requirement',record.id)}>{record.receipt ? 'View commitment' : 'Review requirement'} →</a></div>
  </article>)}</>;
}
export function SlotCards({ slots }: { slots:SlotView[] }) {
  return <>{slots.map(slot => <article key={slot.slotId} className="card">
    <div className="card-top"><span className="eyebrow">{slot.specificationId.replaceAll('-',' ')} / rev {slot.specificationRevision}</span><span className="tag">{slot.state}</span></div>
    <h3>{slot.quantity.value} {slot.quantity.unit}{slot.quantity.value === 1 ? '' : 's'}</h3><p>Reviewed synthetic specification · {slot.releasedSpecification.criteria.process.replaceAll('_',' ')}<br/>Purchase by {when(slot.expiresAt)}</p>
    <div className="amounts"><div><strong>{money(slot.compensation.minorUnits,slot.compensation.currency)}</strong><span>Total manufacturing compensation</span></div><div><strong>{money(slot.slotPrice.minorUnits,slot.slotPrice.currency)}</strong><span>Separate slot price</span></div></div>
    <div className="card-bottom"><span className="muted">Full fixed allocation</span><a href={slot.commitmentId ? link('commitment',slot.commitmentId) : link('slot',slot.slotId,slot.requirementId)}>{slot.commitmentId ? 'View commitment' : 'Inspect terms'} →</a></div>
  </article>)}</>;
}
export function Specification({ slot }: { slot:Pick<SlotView,'specificationId'|'specificationRevision'|'releasedSpecification'> }) {
  const criteria = slot.releasedSpecification.criteria;
  return <section className="panel"><h2>Released specification</h2><dl className="facts">
    <div><dt>Reference</dt><dd>{slot.specificationId} · revision {slot.specificationRevision}</dd></div>
    <div><dt>Process</dt><dd>{criteria.process.replaceAll('_',' ')}</dd></div><div><dt>Material</dt><dd>{criteria.material.replaceAll('_',' ')}</dd></div>
    <div><dt>Fixture width</dt><dd>{criteria.dimensions.width} {criteria.dimensions.unit}</dd></div>
  </dl><p className="note">Reviewed test reference. {criteria.acceptance}. This is not an engineering release for physical manufacturing.</p></section>;
}
export function Terms({ slot }: { slot:Pick<SlotView,'termsId'|'termsRevision'|'requirementRevision'|'fixtureTerms'> }) {
  return <section className="panel"><h2>Frozen terms</h2><ul className="terms">
    <li>Terms {slot.termsId} · revision {slot.termsRevision}; requirement revision {slot.requirementRevision}.</li>
    <li>Compensation is the total for the full slot, conditional on accepted full-slot goods. Settlement is not implemented.</li>
    <li>The separate synthetic slot price goes to {slot.fixtureTerms.recipientAccount}.</li>
    <li>Only unpurchased holds can be withdrawn or released on processed expiry. Purchased compensation stays reserved.</li>
    <li>No transport charge is included. Transport and fulfillment follow later.</li>
  </ul></section>;
}
export function Audit({ events,producer }: { events:AuditEvent[];producer:boolean }) {
  return <section className="panel"><h2>Scoped audit trail</h2><p className="muted">{producer ? 'Only events attributable to your actor are shown.' : 'Attributable events for this requirement.'} Up to 20 events.</p>
    <ol className="audit">{events.length ? events.map((event,index) => <li key={`${event.happenedAt}:${event.operation}:${index}`}>
      <strong>{human(event.operation)}</strong><small>{event.actorId} · {event.organizationId}<br/>{when(event.happenedAt)}</small>{event.reason !== event.operation && <p>{event.reason}</p>}
    </li>) : <li>No events visible to this grant yet.</li>}</ol>
  </section>;
}
export function MoneyRow({ label,detail,minor,currency }: { label:string;detail?:string;minor:number;currency?:string }) {
  return <div className="money-row"><div>{label}{detail && <><br/><span>{detail}</span></>}</div><strong>{money(minor,currency)}</strong></div>;
}
