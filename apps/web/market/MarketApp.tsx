import { useEffect,useLayoutEffect,useRef,useState,useSyncExternalStore } from 'react';
import type { Command } from '../../../packages/contracts/src/index.ts';
import { marketCommandNames } from '../../../packages/contracts/src/operation-names.ts';
import type { MarketWorkspace } from '../../../packages/contracts/src/market.ts';
import { WebClient,PendingStore,createPending,retainPending } from '../client.ts';
import type { Session,Pending,Failure } from '../client.ts';
import {ExchangeApp} from '../producer-exchange/ExchangeApp.tsx';
import { EmptyState } from './components.tsx';
import { Catalog,MarketPageView,business } from './pages.tsx';
import { loadMarketView,marketLink } from './model.ts';
import type { MarketView } from './model.ts';

const subscribeHash = (changed:()=>void) => { window.addEventListener('hashchange',changed);return () => window.removeEventListener('hashchange',changed); };
const readHash = () => window.location.hash;
function participantDescription(workspace?:MarketWorkspace) {
  if (!workspace) return 'Select an enrolled demo participant to open the shared market.';
  if (workspace.permissions.canConfirm) return `${business(workspace.organizationId)} · Authorized participant with explicit party confirmation`;
  return `${business(workspace.organizationId)} · Delegated market participant; human consent remains separate`;
}

export function MarketApp({ client,store }:{ client:WebClient;store:PendingStore }) {
  const isolatedWorkProfile=window.location.pathname==='/app' || document.getElementById('root')?.dataset.legacyWorkspace==='disabled';
  const hash = useSyncExternalStore(subscribeHash,readHash,() => '');
  const [session,setSession] = useState<Session>(),[bootError,setBootError] = useState<string>();
  const [view,setView] = useState<MarketView>(),[revision,setRevision] = useState(0),[busy,setBusy] = useState(false);
  const [notice,setNotice] = useState<{text:string;error:boolean}>();
  const main = useRef<HTMLElement>(null),inFlight = useRef(false),mounted = useRef(true),previousFocus = useRef('');
  const key = JSON.stringify([session?.csrf,hash,revision]);
  const ready = view?.key === key,workspace = view?.csrf === session?.csrf ? view?.workspace : undefined;
  const loading = !bootError && (!session || session.signedIn && !ready);
  let pending:Pending|undefined,recoveryError:string|undefined;
  try { if (session?.persona) pending = store.read(session.persona); }
  catch { recoveryError = 'Saved-request storage is unavailable or unreadable. Commands are paused to preserve any earlier intent.'; }
  const message = (text:string,error = false) => setNotice({text,error});
  const refresh = () => setRevision(value => value+1);

  useEffect(() => {
    mounted.current = true;let active = true;
    void client.boot().then(value => { if (active) setSession(value); },error => {
      if (active) { setBootError((error as Error).message);message((error as Error).message,true); }
    });
    return () => { active = false;mounted.current = false; };
  },[client]);
  useEffect(() => {
    if (!session?.signedIn) return;
    let active = true;
    // Reads remain harmless while navigation, identity or refresh invalidates
    // their result. Neither mounting nor a navigation effect dispatches writes.
    void loadMarketView(client,session,hash,key).then(next => {
      if (!active) return;
      setView(next);
      if (next.error) message(next.error.message,true);
    });
    return () => { active = false; };
  },[client,session,hash,key]);
  useLayoutEffect(() => {
    const destination = `${session?.persona}:${hash}`;
    if (session?.signedIn && ready && !busy && previousFocus.current !== destination) {
      main.current?.focus({ preventScroll:true });window.scrollTo({ top:0,behavior:'instant' });previousFocus.current = destination;
    }
  },[session,hash,ready,busy]);

  async function switchPersona(persona?:string) {
    if (inFlight.current || !session) return;
    inFlight.current = true;setBusy(true);
    try {
      const next = await client.switchSession(session,persona);
      if (!mounted.current) return;
      setSession(next);setNotice(undefined);if (!persona) window.location.hash = '';refresh();
    } catch (error) { if (mounted.current) message((error as Error).message,true); }
    finally { inFlight.current = false;if (mounted.current) setBusy(false); }
  }
  async function perform(request:Pending) {
    if (inFlight.current || !session || request.persona !== session.persona) return;
    if (!marketCommandNames.includes(request.operation as typeof marketCommandNames[number])) {
      message('This saved request belongs to the retained legacy workspace and cannot run in the new work-order demo.',true);return;
    }
    // A ref blocks a second event before React can disable a submitted form.
    inFlight.current = true;setBusy(true);
    const owner = session,originalHash = window.location.hash,keepJob=view?.page?.kind==='work'&&Boolean(view.page.workOrder.printRequirements);
    try {
      const result = await client.call(owner,request.operation,request.input);
      store.complete(request);
      if (mounted.current) {
        message(request.label);
        if (window.location.hash === originalHash && !keepJob) {
          if (result.recordIds.marketCommitmentId || result.recordIds.commitmentId) window.location.hash = marketLink('commitment',result.recordIds.marketCommitmentId ?? result.recordIds.commitmentId!);
          else if (result.recordIds.proposalId) window.location.hash = marketLink('proposal',result.recordIds.proposalId);
          else if (request.operation === 'postWorkOrder' && (result.recordIds.workOrderId || result.recordIds.orderId)) window.location.hash = marketLink('work',result.recordIds.workOrderId ?? result.recordIds.orderId!);
          else if (result.recordIds.orderId) window.location.hash = marketLink('order',result.recordIds.orderId);
        }
      }
    } catch (error) {
      const failure = error as Failure;
      try { if (retainPending(request,failure)) store.save({ ...request,uncertain:true });else store.complete(request); }
      catch { /* Saved intent remains; another command cannot bypass recovery. */ }
      if (mounted.current) message(failure.code ? `${failure.message}${failure.details ? ` ${failure.details}` : ''}` : 'The reply was interrupted. The request may have committed. Retry the saved request to recover its original result.',true);
    } finally { inFlight.current = false;if (mounted.current) { setBusy(false);refresh(); } }
  }
  function command(operation:Command,input:Record<string,unknown>,label:string) {
    if (inFlight.current || !session?.persona || loading) return;
    try {
      if (store.read(session.persona)) { message('A request needs recovery. Retry the saved request before starting another action.',true);return; }
      const request = createPending(session.persona,operation,input,label,crypto.randomUUID());
      // Persist the original identity, terms and retry key BEFORE dispatch.
      store.save(request);void perform(request);
    } catch { message('The request could not be saved safely in this tab. No command was sent. Restore saved-request storage before continuing.',true); }
  }
  function retry() {
    if (!session?.persona) return;
    try { const request = store.read(session.persona);if (request) void perform(request); }
    catch { message('The saved request is unreadable. No new command was sent.',true); }
  }
  const actions = { blocked:busy || loading || Boolean(pending || recoveryError),command,refresh,message };
  const route = hash.slice(1).split('?')[0]?.split('/')[0],page = ready ? view?.page : undefined;
  const currentItemId=page?.kind==='market'?page.book.item.itemId:undefined;
  const buying=!route||['materials','post-material','order'].includes(route);
  const ownOrders=['orders','proposal','commitment','sourcing'].includes(route??'');
  return <div className="market-root">
    <a className="market-skip" href="#market-app" onClick={event => { event.preventDefault();main.current?.focus(); }}>Skip to market workspace</a>
    <header className="market-masthead"><a className="market-brand" href="#materials"><span className="market-mark" aria-hidden="true">V</span><span>Vista Verde<small>Simulation</small></span></a>
      {session?.signedIn&&<div className="compact-account"><label className="market-sr-only" htmlFor="market-persona">Demo participant</label><select id="market-persona" value={session.persona??''} disabled={busy} onChange={event=>{void switchPersona(event.target.value);}}>{session.personas.map(persona=><option key={persona.id} value={persona.id}>{({'buyer-agent':'Buyer agent',buyer:'Buyer','producer-a':'Producer A','producer-b':'Producer B'} as Record<string,string>)[persona.id]??persona.label}</option>)}</select><button className="market-quiet market-small" id="logout" disabled={busy} onClick={()=>{void switchPersona();}}>Sign out</button></div>}
    </header>
    {session?.signedIn&&<div className="compact-navigation"><nav className="market-tabs" aria-label="Market workspace"><a href="#materials" aria-current={buying?'page':undefined}>Buy</a><a href="#work-orders" aria-current={!buying&&!ownOrders?'page':undefined}>Work Orders</a><a href="#orders" aria-current={ownOrders?'page':undefined}>My Orders</a></nav><div className="compact-utilities">{session.producerExchange&&<a href="#exchange">Request a quote</a>}<details className="compact-more"><summary>More</summary><nav aria-label="Other tools"><a href="#jobs">Print jobs</a><a href="#new-print">Create print job</a><a href="#sourcing">Inventory &amp; stages</a><a href="#market">Item comparison</a><a href="#route-demo">Route demo</a><a href="#print-demo">3D print demo</a><a href="#house">House project</a>{!isolatedWorkProfile&&<a href="/legacy">Legacy production slots ↗</a>}</nav></details></div></div>}
    <main ref={main} id="market-app" className="market-main" tabIndex={-1} aria-busy={loading || busy} data-persona={session?.persona ?? ''}>
      <h1 className="market-sr-only">Vista Verde market</h1>
      {pending && !busy && <div className="market-note warning market-recovery" role="status"><div><strong>A saved request needs recovery.</strong><p>Original terms and retry key are retained in this tab. {pending.label}</p></div><button id="retry" disabled={!session?.signedIn} onClick={retry}>Retry saved request</button></div>}
      {recoveryError && <p className="market-note warning" role="alert" style={{ marginBottom:20 }}>{recoveryError}</p>}
      {bootError ? <EmptyState title="The local market is unavailable"><p>Reopen the isolated fixture and its loopback URL.</p></EmptyState> : !session ? <p className="market-loading" role="status">Opening the demo session…</p> : !session.signedIn ? <section className="market-login"><h2>Open the demo market</h2><p>Choose a participant to browse goods or post work.</p><div className="market-login-grid">{session.personas.map(persona=><button className="market-login-option" key={persona.id} disabled={busy} onClick={()=>{void switchPersona(persona.id);}}><strong>{persona.label}</strong></button>)}</div><p className="compact-disclosure">Simulation · No real payments or printing.</p></section> : <>
        {view?.partialErrors.map(error => <p className="market-note warning" key={error} style={{ marginBottom:18 }} role="status">{error}</p>)}
        <div className={route==='market'?'market-layout':undefined}>
          {route==='market'&&<Catalog key={session.csrf} client={client} session={session} revision={revision} selectedItemId={currentItemId}/>}
          {!ready ? <p className="market-loading" role="status">Loading current shared records…</p> : view?.error ? <EmptyState title="This view is unavailable"><p>{view.error.message}</p><div className="market-form-actions" style={{ justifyContent:'center' }}><button onClick={refresh} disabled={busy}>Refresh view</button><a href="#">Return to item market</a></div></EmptyState> : page?.kind==='producer-exchange'&&workspace&&session.producerExchange ? <ExchangeApp key={session.csrf} csrf={session.csrf} persona={session.persona!} canSubmit={workspace.permissions.canPostWorkOrder} canApprove={workspace.permissions.canPostWorkOrder&&workspace.permissions.canConfirm}/> : page && workspace ? <MarketPageView key={key} page={page} workspace={workspace} items={view.items} actions={actions}/> : <EmptyState title="No records available"><p>Select a participant and refresh the shared market.</p></EmptyState>}
        </div>
      </>}
    </main>
    {notice && <div className={`market-notice ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'} aria-live={notice.error ? 'assertive' : 'polite'}><p>{notice.text}</p><button aria-label="Dismiss notification" onClick={() => setNotice(undefined)}>×</button></div>}
    <footer className="market-footer"><span>Simulation · No real payments or printing.</span><details><summary>About this demo</summary><p>{participantDescription(workspace)}</p><p>Work orders and supply share persisted synthetic records. Producer quotes use a separate in-memory service; its records reset on restart. Original slot records stay in the retained database.</p></details></footer>
  </div>;
}
