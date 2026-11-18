import {dollars} from '../../producer-demo/protocol.ts';
import type {ExchangeView as View} from '../../producer-demo/protocol.ts';

export function ExchangeView({view,busy=false,pending=false,canApprove=false,onApprove=()=>{},onSelect=()=>{}}:{view?:View;busy?:boolean;pending?:boolean;canApprove?:boolean;onApprove?:()=>void;onSelect?:(id:string)=>void}){
  const e=view?.exchange;
  return <section className="exchange-result" aria-label="Producer exchange">
    <p className="exchange-boundary">Simulated quote · No real printing or payments.</p>

    {!e?<p>Send a brief to receive a conditional quote, or open a request from this run.</p>:<>
      <h2>Conditional producer quote</h2>
      <p>{e.brief.need} · {e.brief.quantity} each · {e.brief.material}</p>
      <dl className="exchange-terms"><div><dt>Producer quote</dt><dd>{dollars(e.quote.priceMinor)} USD</dd></div><div><dt>Stated budget</dt><dd>{dollars(e.brief.budgetMinor)} USD</dd></div><div><dt>Mock lead time</dt><dd>{e.quote.leadHours} hours after producer acceptance</dd></div><div><dt>Expires</dt><dd>{e.quote.expiresAt}</dd></div></dl>
      <p className="compact-disclosure">No STL supplied. Material compatibility is unverified.</p><details><summary>Quote assumptions</summary><ul>{e.quote.assumptions.map(line=><li key={line}>{line}</li>)}</ul></details>
      {e.quote.blockers.length>0&&<div role="alert"><strong>Approval blocked</strong><ul>{e.quote.blockers.map(line=><li key={line}>{line}</li>)}</ul></div>}
      {!e.job?<><button type="button" disabled={busy||pending||!canApprove||e.quote.blockers.length>0} onClick={onApprove}>Approve {dollars(e.quote.priceMinor)} quote</button><p>Explicit approval starts one simulated job. No payment is made.</p></>:<div role="status"><h3>{e.job.state==='completed_simulated'?'Completed · simulated':e.job.state==='failed_simulated'?'Failed · simulated':e.job.state==='printing'?'Printing · simulated':'Queued · simulated'}</h3><p>Accepted by the simulated producer · update {e.job.sequence}.</p><p>{e.job.state==='failed_simulated'?'The fixture reports a failed job. Review the failure and submit a new request explicitly; retrying approval cannot create another job.':'Status originates in the producer process. No machine or geometry was verified.'}</p></div>}
      <details className="exchange-technical"><summary>Technical details</summary><p>Deterministic requester · real HTTP exchange · shared by organization. File-backed records survive restart; memory-mode records clear. Offline time does not prove progress.</p><p className="exchange-id">Run {view!.runId} · observed {view!.observedAt}</p>      <p className="exchange-id">Request {e.requestId} · quote {e.quote.quoteId} · revision {e.quote.revision}<br/>Frozen terms SHA-256 {e.quote.termsDigest}</p>
{e.job&&<p className="exchange-id">Job {e.job.jobId} · accepted {e.job.producerAcceptedAt}</p>}<h3>Received message trail</h3><ol className="exchange-messages">{e.messages.map(message=><li key={message.messageId}><strong>{message.sender==='requester'?'Requester → producer':'Producer → requester'} · {message.kind}</strong><p>{message.summary}</p><small>{message.at} · sequence {message.sequence}<br/>Correlation {message.correlationId}{message.replyTo&&<> · replies to {message.replyTo}</>}</small></li>)}</ol></details>
    </>}
    {Boolean(view?.recent.length)&&<details><summary>Recent requests ({view!.recent.length})</summary><ul>{view!.recent.map(item=><li key={item.requestId}><button type="button" disabled={busy||pending} onClick={()=>onSelect(item.requestId)}>{item.need} · {item.state}</button></li>)}</ul></details>}
  </section>;
}
