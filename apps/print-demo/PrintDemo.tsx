import {useRef,useState} from 'react';
import {advance,defaults,fixtureMesh,inspectStl,MAX_STL_BYTES,quote,stages,usd} from './model.ts';
import type {Mesh,PrintTerms,Stage} from './model.ts';

export function PrintDemo({initialFixture=false,appLink=false}:{initialFixture?:boolean;appLink?:boolean}) {
  const [mesh,setMesh]=useState<Mesh|undefined>(()=>initialFixture ? fixtureMesh() : undefined);
  const [terms,setTerms]=useState<PrintTerms>(()=>({...defaults,units:initialFixture ? 'mm' : ''}));
  const [stage,setStage]=useState<Stage>('draft'),[error,setError]=useState(''),[notice,setNotice]=useState(''),[reading,setReading]=useState(false);
  const fileEpoch=useRef(0),input=useRef<HTMLInputElement>(null);
  const offer=quote(mesh,terms),valid=offer.issues.length===0 && !reading;
  function resetApproval() {setStage('draft');setError('');setNotice('Changed inputs invalidate both local approvals and restart this simulation.');}
  function change<K extends keyof PrintTerms>(key:K,value:PrintTerms[K]) {setTerms(current=>({...current,[key]:value,...(key!=='customerAccepted' ? {customerAccepted:false} : {})}));resetApproval();}
  async function load(file?:File) {
    const epoch=++fileEpoch.current;resetApproval();setMesh(undefined);setTerms(current=>({...current,units:'',customerAccepted:false}));
    if (!file) {setReading(false);return;}
    setReading(true);
    try {
      if (file.size>MAX_STL_BYTES) throw new Error('STL must be no larger than 10 MiB.');
      const inspected=inspectStl(await file.arrayBuffer());
      if (fileEpoch.current===epoch) {setMesh(inspected);setNotice('Local file inspected in this tab. Confirm its coordinate units; no upload occurred.');}
    } catch (failure) {if (fileEpoch.current===epoch) setError((failure as Error).message);}
    finally {if (fileEpoch.current===epoch) setReading(false);if(input.current) input.current.value='';}
  }
  function fixture() {++fileEpoch.current;setReading(false);setMesh(fixtureMesh());setTerms({...defaults,units:'mm'});resetApproval();setNotice('Bundled synthetic cube loaded. This is a test fixture, not your design.');}
  function move(event:Parameters<typeof advance>[1]) {try {setStage(advance(stage,event,valid));setNotice('Local simulation checkpoint recorded in this tab.');}catch(failure){setError((failure as Error).message);}}
  const completed=stages.indexOf(stage);
  return <section className="print-demo" aria-label="Mock 3D-print journey">
    <header className="print-header"><p className="print-eyebrow">FIRST CONCRETE EXAMPLE / ALL PARTICIPANTS FICTIONAL</p><h1>A small print. An explicit agreement.</h1><p>Supply an STL and material requirements, compare a mock printer and feedstock source, then approve a mock courier plan. Every quote, capacity, production event and tracking status below is simulated.</p><span className="print-badge">Local simulation · No orders, uploads or payments</span>{appLink && <p className="print-app-link"><a href="/app#print-demo" target="_top">Open the synthetic app →</a></p>}</header>
    <div className="print-layout"><div className="print-stack">
      <section className="print-card" aria-labelledby="print-input-title"><p className="print-eyebrow">01 / REQUIREMENTS</p><h2 id="print-input-title">Your local model and print specification</h2>
        <label htmlFor="print-file">Inspect a local STL (up to 10 MiB)</label><input ref={input} id="print-file" type="file" accept=".stl" onChange={event=>{void load(event.target.files?.[0]);}}/>
        <p className="print-small">File bytes and names stay in this tab’s memory. They are never sent to the backend, saved in browser storage or shared with a provider. Navigating away clears this planner.</p>
        <button type="button" className="print-secondary" onClick={fixture}>Load synthetic 20 mm cube</button>
        <p role="status" className="print-model">{reading ? 'Inspecting local STL…' : mesh ? `${mesh.synthetic ? 'Bundled synthetic test fixture · not your design' : 'Local user file · no upload'} · ${mesh.format} · ${mesh.triangles} triangles · bounds ${mesh.bounds.map(value=>value.toFixed(2)).join(' × ')} coordinate units` : 'Upload required · no user design has been supplied.'}</p>
        <div className="print-fields"><label>STL coordinate units<select value={terms.units} onChange={event=>change('units',event.target.value as PrintTerms['units'])}><option value="">Confirm units…</option><option value="mm">Millimetres</option><option value="inch">Inches</option></select></label>
          <label>Process and material<select value={terms.material} onChange={event=>change('material',event.target.value as PrintTerms['material'])}><option value="petg">FDM · PETG · 1.75 mm · black (mock)</option><option value="resin">SLA · resin (incompatible mock profile)</option><option value="wide">FDM · PETG · 2.85 mm (incompatible)</option></select></label>
          <label>Counted parts<input value={terms.quantity} inputMode="numeric" maxLength={2} onChange={event=>change('quantity',event.target.value)}/></label>
          <label>Print budget (USD)<input value={terms.printBudget} inputMode="decimal" maxLength={9} onChange={event=>change('printBudget',event.target.value)}/></label>
          <label>Delivery allowance (USD)<input value={terms.deliveryBudget} inputMode="decimal" maxLength={9} onChange={event=>change('deliveryBudget',event.target.value)}/></label>
          <label>In-hand deadline (days from demo start)<input value={terms.deadlineDays} inputMode="numeric" maxLength={2} onChange={event=>change('deadlineDays',event.target.value)}/></label>
          <label>Mock delivery zone<select value={terms.zone} onChange={event=>change('zone',event.target.value as 'A'|'B')}><option value="A">Fictional Zone A · day 6 · $10</option><option value="B">Fictional Zone B · day 9 · $18</option></select></label>
          <label>Material responsibility<select value={terms.source} onChange={event=>change('source',event.target.value as PrintTerms['source'])}><option value="producer">Printer sources material (default)</option><option value="customer">Customer supplies material</option></select></label>
        </div>
        {terms.source==='customer' && <label className="print-check"><input type="checkbox" checked={terms.customerAccepted} onChange={event=>change('customerAccepted',event.target.checked)}/>Mock producer explicitly accepts the customer’s PETG / 1.75 mm material for this job.</label>}
        <details><summary>Optional quality, use and confidentiality notes</summary><label>Local review notes<textarea rows={3} maxLength={1000} value={terms.notes} placeholder="Intended use, tolerance, finish, grade/color or disclosure restrictions" onChange={event=>change('notes',event.target.value)}/></label><p className="print-small">Notes require future producer review. This demo performs no engineering, structural, confidentiality or quality validation.</p></details>
        <p className="print-small">Inspection establishes counts and bounds only. STL declares no units and does not prove watertight geometry, material consumption, orientation, tolerances or printability.</p>
      </section>
      <section className="print-card" aria-labelledby="print-supply-title"><p className="print-eyebrow">02 / FICTIONAL SUPPLY CHAIN</p><h2 id="print-supply-title">Feedstock → printer → courier</h2>
        <ol className="print-participants"><li><strong>MockSpool Materials</strong><span>Synthetic PETG / 1.75 mm stock · 4 counted spools · fabricated availability day 0. A candidate source, with no purchase or reservation.</span></li><li><strong>DemoForge Workshop · imaginary P1 printer</strong><span>Mock FDM profile · 220 × 220 × 250 mm envelope · 10-part capacity · readiness day 3. This is an invented machine, not a real producer.</span></li><li><strong>Pretend Parcel Courier</strong><span>Mock packing day 4, dispatch day 5, arrival day {offer.arrivalDay}. No carrier booking, physical custody or real tracking.</span></li></ol>
        <p className="print-small">The supply source is independent. The printer’s stated price includes its sourcing responsibility by default. A counted spool is not converted into consumed grams or a computed bill of materials.</p>
      </section>
      <section className="print-card" aria-labelledby="print-progress-title"><p className="print-eyebrow">04 / LOCAL SCRIPTED SIMULATION</p><h2 id="print-progress-title">Two approvals, then simulated production</h2>
        <ol className="print-timeline">{['Prepare nonbinding requirements and mock quote','Human reviews print terms; mock producer consents','Human approves separate courier allowance and zone','Simulated printing / no machine execution','Simulated dispatch / DEMO-PARCEL-001','Simulated delivered / receipt still pending','Human acknowledges simulated receipt'].map((label,index)=><li key={label} data-done={index<=completed}><span aria-hidden="true">{index<=completed ? '✓' : '○'}</span>{label}{index===completed && <strong> · current</strong>}</li>)}</ol>
        <p className="print-small">A simulated “delivered” event never acknowledges receipt automatically. No agent model or autonomous runner is connected; this is deterministic local software.</p>
      </section>
    </div><aside className="print-card print-review" aria-label="Review mock quote and approvals"><p className="print-eyebrow">03 / REVIEW THE TERMS</p><h2>One clear customer quote</h2>
      <dl><div><dt>Mock print total ({terms.quantity || '0'} parts)</dt><dd>{usd(offer.printTotal)}</dd></div><div><dt>Material contribution already inside print price</dt><dd>{usd(offer.materialContribution)}</dd></div><div><dt>Separate mock courier</dt><dd>{usd(offer.delivery)}</dd></div><div className="print-total"><dt>Illustrative customer total</dt><dd>{usd(offer.total)}</dd></div></dl>
      <p className="print-small">{terms.source==='producer' ? 'The material contribution is informational; do not add it again. No full spool charge is added to the customer job.' : 'Customer material is excluded from the mock printer price. Its separate acquisition cost is unknown and is not included in this quoted total.'} These fabricated prices are not market quotes, funded balances or payments.</p>
      {offer.dimensions && <p className="print-small">Interpreted bounds: {offer.dimensions.map(value=>value.toFixed(2)).join(' × ')} mm. This is a mock envelope check only.</p>}
      {offer.issues.length>0 ? <div className="print-blocked" role="status"><strong>Before local approval</strong><ul>{offer.issues.map(issue=><li key={issue}>{issue}</li>)}</ul></div> : <p className="print-ready" role="status">Mock profile, envelope, quantity, budgets and timing checks pass.</p>}
      <p><strong>Simulation state: {stage.replaceAll('_',' ')}</strong></p>
      {stage==='draft' && <button disabled={!valid} onClick={()=>move('approve_print')}>Approve mock print terms</button>}
      {stage==='print_approved' && <button disabled={!valid} onClick={()=>move('approve_delivery')}>Approve mock delivery plan</button>}
      {stage==='delivery_approved' && <button disabled={!valid} onClick={()=>move('produce')}>Simulate printing</button>}
      {stage==='printing' && <button disabled={!valid} onClick={()=>move('dispatch')}>Simulate courier dispatch</button>}
      {stage==='dispatched' && <button disabled={!valid} onClick={()=>move('deliver')}>Simulate delivered event</button>}
      {stage==='delivered' && <button disabled={!valid} onClick={()=>move('acknowledge')}>Acknowledge simulated receipt</button>}
      {stage==='acknowledged' && <p className="print-ready">Simulated receipt acknowledged. No real goods moved.</p>}
      <p className="print-small">Every input change invalidates both approvals and restarts this local simulation. That reset is not cancellation of a persisted agreement.</p>
      <details><summary>What the executable backend proof establishes</summary><p className="print-small">The separate disposable-database example uses real stdio MCP commands and HTTP readback for genuine synthetic print/material items, proposals, both-party consent and counted fulfillment. This planner sends no commands or STL data. Printer and courier events remain scripted simulation in both examples.</p><p className="print-small">Existing buyer-agent grants cannot confirm; producer grants can. This demonstrates the requester review checkpoint, not universal human approval or production agent mandates.</p></details>
    </aside></div>
    {error && <p className="print-error" role="alert">{error}</p>}{notice && <p className="print-small" role="status">{notice}</p>}
  </section>;
}
