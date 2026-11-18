import { useEffect,useRef,useState } from 'react';
import type { FormEvent } from 'react';
import type { Command,Input } from '../../packages/contracts/src/index.ts';
import type { Workspace,SlotView } from '../../packages/contracts/src/views.ts';
import { usd,WebClient } from './client.ts';
import type { Session } from './client.ts';
import type { PageData } from './model.ts';
import { Field,Empty,RecordCards,SlotCards,Specification,Terms,Audit,MoneyRow,link,money,when } from './components.tsx';

export type Actions = { blocked:boolean;command:(operation:Command,input:Record<string,unknown>,label:string)=>void;refresh:()=>void;message:(text:string,error?:boolean)=>void };
export function Login({ session,blocked,onSwitch }: { session:Session;blocked:boolean;onSwitch:(persona:string)=>void }) {
  const [persona,setPersona] = useState(session.personas[0]?.id ?? '');
  return <section className="login"><p className="eyebrow">Vista Verde Labs / Manufacturing</p><h1>A shared place<br/>to put demand to work.</h1><p>Agents post requirements. People review the terms. Producers commit to defined allocations.</p>
    <div className="panel"><h2>Explore the local demonstration</h2><p>Choose a seeded fixture role. Every amount, specification and transaction is synthetic. This role selector is not production authentication.</p>
      <form id="login-form" onSubmit={event => { event.preventDefault();onSwitch(persona); }}><div className="field"><label htmlFor="login-persona">Demo role</label>
        <select id="login-persona" value={persona} disabled={blocked} onChange={event => setPersona(event.target.value)}>{session.personas.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select></div>
        <button className="primary full" type="submit" disabled={blocked}>Open workspace</button></form>
      <div className="steps"><span><b>01</b>Draft demand</span><span><b>02</b>Reserve funding</span><span><b>03</b>Purchase allocation</span></div>
    </div>
  </section>;
}
function Listing({ data,workspace,client,session,actions }: { data:Extract<PageData,{kind:'listing'}>;workspace:Workspace;client:WebClient;session:Session;actions:Actions }) {
  const [records,setRecords] = useState(data.records),[slots,setSlots] = useState(data.slots),[cursor,setCursor] = useState(data.cursor),[loading,setLoading] = useState(false);
  const inFlight = useRef(false),alive = useRef(true);
  useEffect(() => { alive.current = true;return () => { alive.current = false; }; },[]);
  async function more() {
    if (inFlight.current || !cursor) return;
    inFlight.current = true;setLoading(true);
    try {
      const next = await client.call(session,data.mode === 'slots' ? 'listAvailableSlots' : 'getWorkspace',{ cursor,limit:20 });
      if (!alive.current) return;
      if (data.mode === 'slots') {
        const values = next.data.slots as unknown as SlotView[];
        for (const slot of values) sessionStorage.setItem(`vv.slot.${slot.slotId}`,slot.requirementId);
        setSlots(previous => [...previous,...values]);
      } else setRecords(previous => [...previous,...(next.data as unknown as Workspace).records]);
      setCursor(next.data.nextCursor as string|null);
    } catch (error) { if (alive.current) actions.message((error as Error).message,true); }
    finally { inFlight.current = false;if (alive.current) setLoading(false); }
  }
  const available = data.mode === 'slots',hasRecords = available ? slots.length > 0 : records.length > 0;
  return <>
    <div className="section-head"><div><h2>{available ? 'Available production slots' : data.commitments ? 'Your producer commitments' : 'Shared requirements'}</h2>
      <span className="muted">{available ? 'Reviewed eligibility · Published synthetic demand · Whole allocations' : `Persisted work for ${workspace.organizationId}`}</span></div>
      {workspace.role === 'buyer_agent' ? <a href="#draft">Create draft →</a> : <button id="refresh" disabled={actions.blocked} onClick={actions.refresh}>Refresh</button>}
    </div>
    <div id="listing" className={hasRecords ? 'cards' : ''}>
      {hasRecords ? available ? <SlotCards slots={slots}/> : <RecordCards records={records}/> :
        <Empty title={available ? 'No eligible slots available' : data.commitments ? 'No commitments yet' : 'Start with a requirement'}>
          {available ? 'Slots may be purchased, expired, or outside your reviewed capability. New publications appear here after refresh.' : data.commitments ? 'A successful purchase appears here and remains after refresh.' : 'Switch to Buyer agent to create a synthetic draft, or let an MCP agent create one. Buyer human then reviews and publishes.'}
        </Empty>}
    </div>
    <button id="more" className="pagination" hidden={!cursor} disabled={loading || actions.blocked} onClick={() => { void more(); }}>{available ? 'Load more slots' : 'Load more records'}</button>
  </>;
}
function Draft({ workspace,actions }: { workspace:Workspace;actions:Actions }) {
  const [dates] = useState(() => ({ from:new Date(Date.now()+2*86400000).toISOString().slice(0,16),to:new Date(Date.now()+30*86400000).toISOString().slice(0,16) }));
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();if (actions.blocked) return;
    try {
      const form = new FormData(event.currentTarget),spec = workspace.specifications.find(value => value.id === form.get('spec'));
      if (!spec) throw new Error('Choose an available reviewed test specification.');
      const from = new Date(String(form.get('from'))+'Z').toISOString(),to = new Date(String(form.get('to'))+'Z').toISOString();
      if (from >= to) throw new Error('The delivery end must come after the delivery start.');
      actions.command('createRequirementDraft',{ intendedUse:String(form.get('intendedUse')),destination:String(form.get('destination')),
        lines:[{ lineId:'components',quantity:{ value:Number(form.get('quantity')),unit:spec.unit },specificationId:spec.id,specificationRevision:spec.revision }],
        deliveryWindow:{ from,to },acceptanceCriteria:[String(form.get('acceptance'))] },'Draft saved to shared records. Buyer human review is next.');
    } catch (error) { actions.message((error as Error).message,true); }
  }
  return <><a className="back" href="#">← Requirements</a><div className="split"><section className="panel"><p className="eyebrow">Buyer agent fixture</p><h1>Describe the demand.</h1><p>Create a complete synthetic requirement. A human reviews and publishes it next.</p>
    <form id="draft-form" onSubmit={submit}><Field label="Intended use" name="intendedUse" defaultValue="Housing component package" maxLength={500}/>
      <div className="form-grid"><div className="field"><label htmlFor="spec">Reviewed test specification</label><select id="spec" name="spec">{workspace.specifications.map(spec => <option key={spec.id} value={spec.id}>{spec.id.replaceAll('-',' ')} · revision {spec.revision}</option>)}</select></div><Field label="Counted quantity (components)" name="quantity" defaultValue="12" type="number" min="1" max="1000000" step="1"/></div>
      <Field label="Receiving destination" name="destination" defaultValue="Synthetic receiving site" maxLength={300}/>
      <div className="form-grid"><Field label="Delivery starts (UTC)" name="from" defaultValue={dates.from} type="datetime-local"/><Field label="Delivery ends (UTC)" name="to" defaultValue={dates.to} type="datetime-local"/></div>
      <div className="field"><label htmlFor="acceptance">Full-slot acceptance criterion</label><textarea id="acceptance" name="acceptance" maxLength={300} required defaultValue="Synthetic full-slot fixture inspection"/></div>
      <button className="primary" type="submit" disabled={actions.blocked}>Create synthetic draft</button>
    </form>
    </section><aside className="panel"><h2>Agent-first, human-guided</h2><div className="steps"><span><b>01</b>Agent creates demand</span><span><b>02</b>Human authorizes funding</span><span><b>03</b>Producer purchases</span></div>
      <p className="note">This selector represents a seeded buyer-agent grant. A real MCP agent uses the same createRequirementDraft command and database records.</p><p className="muted">Housing and robotics use the same contracts. Specifications are immutable reviewed fixtures. CAD authoring and draft editing are future work.</p>
    </aside></div></>;
}
function Publication({ data,workspace,actions }: { data:Extract<PageData,{kind:'requirement'}>;workspace:Workspace;actions:Actions }) {
  const [compensation,setCompensation] = useState('600.00'),[expiry] = useState(() => new Date(Date.now()+86400000).toISOString().slice(0,16));
  const lines = data.view.draft.lines,terms = workspace.terms.find(value => value.id === 'synthetic-v1');
  let total = '';
  try { const amount = usd(compensation)*lines.length;if (!Number.isSafeInteger(amount)) throw new Error();total = `Total synthetic reservation: ${money(amount)} across ${lines.length} allocation${lines.length === 1 ? '' : 's'}.`; }
  catch { total = 'Enter a valid USD amount to calculate the total reservation.'; }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();if (actions.blocked) return;
    try {
      if (!terms) throw new Error('The released synthetic terms are unavailable.');
      const form = new FormData(event.currentTarget);
      const input: Omit<Input<'publishRequirement'>,'idempotencyKey'> = { requirementId:data.id,expectedRecordVersion:data.response.revisions.recordVersion!,requirementRevision:data.response.revisions.requirementRevision!,
        slots:lines.map(line => ({ ...line,slotId:crypto.randomUUID(),termsId:terms.id,termsRevision:terms.revision,slotPrice:{ minorUnits:usd(form.get('price')),currency:'USD' },compensation:{ minorUnits:usd(form.get('compensation')),currency:'USD' },expiresAt:new Date(String(form.get('expires'))+'Z').toISOString() })) };
      actions.command('publishRequirement',input,'Publication recorded. Full synthetic compensation is reserved.');
    } catch (error) { actions.message((error as Error).message,true); }
  }
  return <section className="panel"><p className="eyebrow">Human authorization</p><h2>Publish {lines.length} full allocation{lines.length === 1 ? '' : 's'}</h2><p>One allocation per component line. Reserve the full manufacturing compensation before this slot becomes available. A shortfall leaves the draft unpublished.</p>
    {data.view.missing.length ? <p className="note warning">Missing: {data.view.missing.join(', ')}. Draft editing is not implemented; create a complete replacement through the buyer agent.</p> :
      <form id="publish-form" onSubmit={submit}><Field label={lines.length === 1 ? 'Total compensation (USD)' : 'Compensation per full allocation (USD)'} name="compensation" value={compensation} onChange={event => setCompensation(event.target.value)} inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?"/>
        <Field label="Separate slot purchase price (USD)" name="price" defaultValue="25.00" inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?"/><Field label="Slot expiry (UTC)" name="expires" defaultValue={expiry} type="datetime-local"/>
        <p className="note" id="publication-total" aria-live="polite">{total}</p><div className="checkbox"><input type="checkbox" id="authorize" required/><label htmlFor="authorize">I reviewed the released specification and synthetic terms, and authorize the full compensation reservation.</label></div>
        <button className="primary full" type="submit" disabled={actions.blocked}>Reserve funds &amp; publish</button>
      </form>}
  </section>;
}
function Requirement({ data,workspace,actions }: { data:Extract<PageData,{kind:'requirement'}>;workspace:Workspace;actions:Actions }) {
  const { draft,slots } = data.view,terms = workspace.terms.find(value => value.id === 'synthetic-v1');
  const references = draft.lines.map(line => workspace.specifications.find(spec => spec.id === line.specificationId && spec.revision === line.specificationRevision)).filter(spec => spec !== undefined);
  return <><a className="back" href="#">← Workspace</a><div className="split"><div className="stack"><section className="panel">
    <div className="card-top"><span className="eyebrow">Requirement · revision {data.response.revisions.requirementRevision}</span><span className={`tag ${data.response.state === 'draft' ? 'draft' : ''}`}>{data.response.state}</span></div>
    <h1 className="detail-title">{draft.intendedUse}</h1><p className="record-id">{data.id}</p><dl className="facts">
      <div><dt>Quantity</dt><dd>{draft.lines.map(line => `${line.quantity.value} ${line.quantity.unit}`).join(', ')}</dd></div><div><dt>Destination</dt><dd>{draft.destination || 'Missing'}</dd></div>
      <div><dt>Delivery window (UTC)</dt><dd>{draft.deliveryWindow ? `${when(draft.deliveryWindow.from)} — ${when(draft.deliveryWindow.to)}` : 'Missing'}</dd></div>
      <div><dt>Released references</dt><dd>{draft.lines.map(line => <div key={line.lineId}>{line.specificationId} · revision {line.specificationRevision}</div>)}</dd></div>
    </dl><h3>Acceptance criteria</h3><ul>{draft.acceptanceCriteria?.map((criterion,index) => <li key={index}>{criterion}</li>) ?? <li>Missing</li>}</ul>
    {workspace.role === 'buyer_agent' && data.response.state === 'draft' && <p className="note">Draft saved. Switch to Buyer human to review and authorize publication. The agent cannot approve its own funding.</p>}
    </section>{data.response.state === 'draft' && <>{references.map((spec,index) => <Specification key={`${spec.id}:${spec.revision}:${index}`} slot={{ specificationId:spec.id,specificationRevision:spec.revision,releasedSpecification:{ criteria:spec.criteria,reviewedFixture:true } }}/>) }
      {terms && <Terms slot={{ termsId:terms.id,termsRevision:terms.revision,requirementRevision:data.response.revisions.requirementRevision!,fixtureTerms:terms.fixtureTerms }}/>}</>}
      {slots.length > 0 && <section><h2>Published allocations</h2><div className="cards"><SlotCards slots={slots}/></div></section>}
    </div><aside className="stack">{data.response.state === 'draft' && workspace.role === 'buyer_human' && <Publication data={data} workspace={workspace} actions={actions}/>}<Audit events={data.audit} producer={workspace.role === 'producer'}/></aside></div></>;
}
function Slot({ data,workspace,actions }: { data:Extract<PageData,{kind:'slot'}>;workspace:Workspace;actions:Actions }) {
  const [openedAt] = useState(() => Date.now());
  const { slot,view } = data,purchasable = slot.state === 'available' && Date.parse(slot.expiresAt) > openedAt;
  const frozen = { slotId:slot.slotId,expectedRecordVersion:slot.recordVersion,requirementRevision:slot.requirementRevision,specificationRevision:slot.specificationRevision,termsRevision:slot.termsRevision };
  return <><a className="back" href={link('requirement',slot.requirementId)}>← Requirement details</a><div className="split"><div className="stack"><section className="panel">
    <div className="card-top"><span className="eyebrow">Production allocation</span><span className="tag">{slot.state}</span></div><h1 className="detail-title">{view.draft.intendedUse}</h1><p>{slot.quantity.value} {slot.quantity.unit}{slot.quantity.value === 1 ? '' : 's'} · fixed full slot</p><p className="record-id">Slot {slot.slotId}</p><dl className="facts"><div><dt>Destination</dt><dd>{view.draft.destination}</dd></div><div><dt>Purchase deadline</dt><dd>{when(slot.expiresAt)}</dd></div></dl>
    </section><Specification slot={slot}/><Terms slot={slot}/></div><aside className="stack"><section className="panel"><p className="eyebrow">Synthetic economics</p><h2>Review this allocation</h2>
      <MoneyRow label="Manufacturing compensation" detail="Total for accepted full-slot goods" minor={slot.compensation.minorUnits} currency={slot.compensation.currency}/><MoneyRow label="Slot purchase price" detail="Separate synthetic charge" minor={slot.slotPrice.minorUnits} currency={slot.slotPrice.currency}/>
      <p className="note">Publication reserved this slot’s compensation. Purchase binds that existing hold to a commitment. Capacity confirmation remains pending.</p>
      {workspace.role === 'producer' && purchasable ? <form id="purchase-form" onSubmit={event => { event.preventDefault();actions.command('purchaseSlot',frozen,'Purchase recorded. Your commitment and its frozen terms are saved.'); }}>
        <div className="checkbox"><input type="checkbox" id="accept" required/><label htmlFor="accept">I accept the frozen specification and synthetic full-slot terms.</label></div><button className="primary full" type="submit" disabled={actions.blocked}>Purchase synthetic slot</button>
      </form> : <p className="note warning">{purchasable ? 'Only an eligible producer can purchase this allocation.' : 'This allocation is closed or expired. No purchase is available.'}</p>}
      {workspace.role === 'buyer_human' && slot.state === 'available' && <div className="actions"><button id="release" className="secondary" disabled={actions.blocked} onClick={() => actions.command(purchasable ? 'withdrawUnpurchasedSlot' : 'processExpiredSlot',purchasable ? { ...frozen,reason:'Buyer withdrew the unpurchased synthetic allocation through the web workspace.' } : frozen,'Slot closed. Unpurchased compensation released.')}>{purchasable ? 'Withdraw unpurchased slot' : 'Process expiry & release'}</button></div>}
      <button id="refresh" className="quiet full" disabled={actions.blocked} onClick={actions.refresh}>Refresh current state</button>
    </section><Audit events={data.audit} producer={workspace.role === 'producer'}/></aside></div></>;
}
function Commitment({ data,workspace }: { data:Extract<PageData,{kind:'commitment'}>;workspace:Workspace }) {
  const { slot,receipt,view } = data;
  return <><a className="back" href={workspace.role === 'producer' ? '#commitments' : '#'}>← Workspace</a><div className="split"><div className="stack"><section className="panel">
    <div className="receipt-check" aria-hidden="true">✓</div><p className="eyebrow">Persistent producer commitment</p><h1>Allocation recorded.</h1><p>{view.draft.intendedUse} · {slot.quantity.value} {slot.quantity.unit}{slot.quantity.value === 1 ? '' : 's'}</p><p className="record-id">Commitment {data.id}</p>
    <div className="note warning"><strong>Capacity confirmation pending.</strong> Purchase records an obligation; production, transport, acceptance and compensation settlement are not implemented in this slice.</div><dl className="facts"><div><dt>Slot</dt><dd>{receipt.recordIds.slotId}</dd></div><div><dt>Frozen revisions</dt><dd>Requirement {receipt.revisions.requirementRevision} · specification {receipt.revisions.specificationRevision} · terms {receipt.revisions.termsRevision}</dd></div></dl>
    </section><Specification slot={slot}/><Terms slot={slot}/></div><aside className="stack"><section className="panel"><h2>Separate synthetic amounts</h2><MoneyRow label="Slot price charged" minor={slot.slotPrice.minorUnits} currency={slot.slotPrice.currency}/><MoneyRow label="Compensation reserved" minor={slot.compensation.minorUnits} currency={slot.compensation.currency}/><p className="note">The commitment, hold, balanced slot-price journal and audit event were recorded in one database transaction. Refresh or agent reconnect preserves this receipt.</p></section><Audit events={data.audit} producer={workspace.role === 'producer'}/></aside></div></>;
}
export function Page({ data,workspace,client,session,actions }: { data:PageData;workspace:Workspace;client:WebClient;session:Session;actions:Actions }) {
  switch (data.kind) {
    case 'listing':return <Listing data={data} workspace={workspace} client={client} session={session} actions={actions}/>;
    case 'draft':return <Draft workspace={workspace} actions={actions}/>;
    case 'requirement':return <Requirement data={data} workspace={workspace} actions={actions}/>;
    case 'slot':return <Slot data={data} workspace={workspace} actions={actions}/>;
    case 'commitment':return <Commitment data={data} workspace={workspace}/>;
    case 'missingSlot':return <Empty title="Slot no longer available">Refresh the marketplace or check your commitments for a completed purchase.</Empty>;
  }
}
