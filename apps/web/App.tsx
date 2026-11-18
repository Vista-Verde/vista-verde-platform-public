import { useEffect,useLayoutEffect,useRef,useState,useSyncExternalStore } from 'react';
import type { Command } from '../../packages/contracts/src/index.ts';
import { WebClient,PendingStore,createPending,retainPending } from './client.ts';
import type { Session,Pending,Failure } from './client.ts';
import { loadView } from './model.ts';
import type { View } from './model.ts';
import { Empty,WorkspaceHeader,SessionRecovery,link } from './components.tsx';
import { Login,Page } from './pages.tsx';

const subscribeHash = (changed: () => void) => { window.addEventListener('hashchange',changed);return () => window.removeEventListener('hashchange',changed); };
const readHash = () => window.location.hash;
export function App({ client,store }: { client:WebClient;store:PendingStore }) {
  const hash = useSyncExternalStore(subscribeHash,readHash,() => '');
  const [session,setSession] = useState<Session>(),[bootError,setBootError] = useState<string>();
  const [view,setView] = useState<View>(),[revision,setRevision] = useState(0),[busy,setBusy] = useState(false);
  const [notice,setNotice] = useState<{ text:string;error:boolean }>();
  const main = useRef<HTMLElement>(null),inFlight = useRef(false),mounted = useRef(true),previousFocus = useRef('');
  const key = JSON.stringify([session?.csrf,hash,revision]);
  const ready = view?.key === key,workspace = view?.csrf === session?.csrf ? view?.workspace : undefined;
  const loading = !bootError && (!session || session.signedIn && !ready);
  let pending: Pending | undefined,recoveryError: string | undefined;
  try { if (session?.persona) pending = store.read(session.persona); }
  catch { recoveryError = 'Saved-request storage is unavailable or unreadable.'; }
  const message = (text: string,error = false) => setNotice({ text,error });
  const refresh = () => setRevision(value => value+1);

  useEffect(() => {
    mounted.current = true;let active = true;
    void client.boot().then(value => { if (active) setSession(value); },error => {
      if (active) { setBootError((error as Error).message);setNotice({ text:(error as Error).message,error:true }); }
    });
    return () => { active = false;mounted.current = false; };
  },[client]);
  useEffect(() => {
    if (!session?.signedIn) return;
    let active = true;
    // Keep already-dispatched reads alive, but discard their result after route,
    // identity or refresh changes. Late failures cannot overwrite the new view.
    void loadView(client,session,hash,key,sessionStorage).then(next => {
      if (!active) return;
      setView(next);if (next.error) setNotice({ text:next.error.message,error:true });
    });
    return () => { active = false; };
  },[client,session,hash,key]);
  useLayoutEffect(() => {
    const destination = `${session?.persona}:${hash}`;
    if (session?.signedIn && ready && !busy && previousFocus.current !== destination) {
      main.current?.focus({ preventScroll:true });window.scrollTo({ top:0,behavior:'instant' });previousFocus.current = destination;
    }
  },[session,hash,ready,busy]);

  async function switchPersona(persona?: string) {
    if (inFlight.current || !session) return;
    inFlight.current = true;setBusy(true);
    try {
      const next = await client.switchSession(session,persona);
      if (!mounted.current) return;
      setSession(next);setNotice(undefined);window.location.hash = '';refresh();
    } catch (error) { if (mounted.current) message((error as Error).message,true); }
    finally { inFlight.current = false;if (mounted.current) setBusy(false); }
  }
  async function perform(request: Pending) {
    if (inFlight.current || !session || request.persona !== session.persona) return;
    // This ref closes the interval before React commits disabled controls: two
    // submit events in the same turn cannot dispatch two financial requests.
    inFlight.current = true;setBusy(true);
    const owner = session,originalHash = window.location.hash;
    try {
      const result = await client.call(owner,request.operation,request.input);
      store.complete(request);
      if (mounted.current) {
        message(request.label);
        if (window.location.hash === originalHash) {
          if (result.recordIds.commitmentId) window.location.hash = link('commitment',result.recordIds.commitmentId);
          else if (result.recordIds.requirementId) window.location.hash = link('requirement',result.recordIds.requirementId);
        }
      }
    } catch (error) {
      const failure = error as Failure;
      try { if (retainPending(request,failure)) store.save({ ...request,uncertain:true });else store.complete(request); }
      catch { /* The original saved intent remains; never dispatch without saving first. */ }
      if (mounted.current) message(failure.code ? `${failure.message}${failure.details ? ` ${failure.details}` : ''}` : 'The reply was interrupted. The request may have committed. Retry the saved request to recover its original result.',true);
    } finally { inFlight.current = false;if (mounted.current) { setBusy(false);refresh(); } }
  }
  function command(operation: Command,input: Record<string,unknown>,label: string) {
    if (inFlight.current || !session?.persona || loading) return;
    try {
      if (store.read(session.persona)) { message('A request needs recovery. Retry the saved request before starting another action.',true);return; }
      const request = createPending(session.persona,operation,input,label,crypto.randomUUID());
      store.save(request);void perform(request);
    } catch { message('The request could not be saved safely in this tab. No command was sent. Restore saved-request storage before continuing.',true); }
  }
  function retry() {
    if (!session?.persona) return;
    try { const request = store.read(session.persona);if (request) void perform(request); }
    catch { message('The saved request is unreadable. No new command was sent.',true); }
  }
  const actions = { blocked:busy || loading || Boolean(pending || recoveryError),command,refresh,message };
  return <>
    <a className="skip-link" href="#app" onClick={event => { event.preventDefault();main.current?.focus(); }}>Skip to workspace</a>
    <div className="demo-banner"><span className="demo-dot"/> Local synthetic demonstration <span className="banner-detail">All funds, specifications and purchases are simulated.</span></div>
    <header className="masthead"><a className="brand" href="#"><span className="brand-mark" aria-hidden="true">V<span>V</span></span><span>VISTA VERDE<small>Manufacturing marketplace</small></span></a><span className="local-label">Private workspace <span aria-hidden="true">↗</span></span></header>
    <main ref={main} tabIndex={-1} id="app" aria-busy={loading || busy} data-persona={session?.persona ?? ''}>
      {workspace && session?.signedIn && <WorkspaceHeader workspace={workspace} session={session} hash={hash} blocked={busy} pending={busy ? undefined : pending} recoveryError={recoveryError} onSwitch={persona => { void switchPersona(persona); }} onRetry={retry}/>}
      {!workspace && session?.signedIn && <SessionRecovery session={session} blocked={busy} pending={busy ? undefined : pending} recoveryError={recoveryError} onSwitch={persona => { void switchPersona(persona); }} onRetry={retry}/>}
      {bootError ? <Empty title="Local demonstration unavailable">Reopen the isolated fixture and its loopback URL.</Empty> : !session ? <p className="loading">Opening your workspace…</p> : !session.signedIn ?
        <Login session={session} blocked={busy} onSwitch={persona => { void switchPersona(persona); }}/> : !ready ? <p className="loading">Opening your workspace…</p> : view?.error ?
          <><Empty title="This view is unavailable">Check the current demo role and refresh the workspace.</Empty><button onClick={() => { window.location.hash = '';refresh(); }}>Return to workspace</button></> : view?.page && workspace ?
            <Page key={key} data={view.page} workspace={workspace} client={client} session={session} actions={actions}/> : null}
    </main>
    <div id="notice" className={`notice${notice?.error ? ' error' : ''}`} role="status" aria-live="polite" hidden={!notice}>{notice && <><p>{notice.text}</p><button onClick={() => setNotice(undefined)}>Dismiss</button></>}</div>
    <footer><span>Vista Verde</span><span>Agent-first. Human-guided. Shared records.</span><span>Synthetic POC · No real payments</span></footer>
  </>;
}
