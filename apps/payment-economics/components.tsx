import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { baseScenario, breakEven, evaluate, networkEconomics, percentKeys, scenarios, sensitivity, validateScenario } from './model.ts';
import type { Economics, NetworkTrade, Scenario } from './model.ts';

export const usd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const count = (n: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(n);
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
type NumericKey = { [K in keyof Scenario]: Scenario[K] extends number ? K : never }[keyof Scenario];
export function NumberField({ label, value, onChange, percent = false, step = 'any', min = 0, hint }: {
  label: string; value: number; onChange: (value: number) => void; percent?: boolean; step?: string; min?: number; hint?: string;
}) {
  const id = useId();
  return <label className="pe-field" htmlFor={id}><span id={`${id}-label`}>{label}{percent ? ' (%)' : ''}</span>
    <input id={id} type="number" min={min} max={percent ? 100 : undefined} step={step} value={Number((value * (percent ? 100 : 1)).toFixed(6))}
      aria-labelledby={`${id}-label`} aria-describedby={hint ? `${id}-hint` : undefined} onChange={e => onChange(e.target.valueAsNumber / (percent ? 100 : 1))} />
    {hint && <small id={`${id}-hint`}>{hint}</small>}</label>;
}
function SelectField({ label, value, options, onChange }: { label: string; value: string; options: [string,string][]; onChange: (v: string) => void }) {
  const id = useId();
  return <label className="pe-field" htmlFor={id}><span>{label}</span><select id={id} value={value} onChange={e => onChange(e.target.value)}>
    {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>;
}
function Group({ title, children, open = false }: { title: string; children: ReactNode; open?: boolean }) {
  return <details open={open} className="pe-group"><summary>{title}</summary><div className="pe-fields">{children}</div></details>;
}
export function Metric({ label, value, detail, negative = false }: { label: string; value: string; detail: string; negative?: boolean }) {
  return <div className={`pe-metric${negative ? ' pe-negative' : ''}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

export function Waterfall({ result: r }: { result: Economics }) {
  const rows: [string,number,boolean][] = [
    ['Platform revenue',r.revenue,true],['Payment cost retained by platform',-r.processingBurden,false],
    ['Accounts, payouts, routing, verification',-r.providerCost,false],['Dispute fees',-r.disputeCost,false],
    ['Unrecovered principal + other fraud',-r.principalLoss-r.fraudLoss,false],['Support',-r.supportCost,false],
    ['Customer acquisition',-r.acquisition,false],['Contribution',r.contribution,true],['Fixed operations',r.operating-r.contribution,false],['Net operating result',r.operating,true],
  ];
  let running = 0;
  const points = rows.map(([label, value, total]) => {
    const start = total ? 0 : running, end = total ? value : running + value;
    running = end;
    return { label, value, start, end, total };
  });
  const min = Math.min(0,...points.flatMap(p => [p.start,p.end]));
  const max = Math.max(1,...points.flatMap(p => [p.start,p.end]));
  const x = (v: number) => 270 + (v-min)/(max-min)*450;
  return <section aria-labelledby="pe-waterfall-title" className="pe-panel"><h2 id="pe-waterfall-title">Where the platform fee goes</h2>
    <p>Monthly expected values. Reimbursements reduce payment cost; they do not increase platform revenue.</p>
    <svg className="pe-waterfall" viewBox="0 0 850 365" role="img" aria-label="Platform revenue to net operating result waterfall. Exact values follow in the table.">
      <line x1={x(0)} x2={x(0)} y1="0" y2="360" stroke="#66776e" strokeDasharray="3 3" />
      {points.map((p,i) => <g key={p.label}><text x="0" y={i*35+24}>{p.label}</text>
        <rect x={Math.min(x(p.start),x(p.end))} y={i*35+8} width={Math.max(1,Math.abs(x(p.end)-x(p.start)))} height="22"
          fill={p.value < 0 ? '#944d34' : '#28654d'} rx="3" /><text x="735" y={i*35+24}>{usd(p.value)}</text></g>)}
    </svg>
    <div className="pe-table-wrap"><table><caption>Monthly platform waterfall, USD</caption><tbody>{rows.map(([label,v]) => <tr key={label}><th scope="row">{label}</th><td>{usd(v)}</td></tr>)}</tbody></table></div>
  </section>;
}

export function SensitivityChart({ title, rows, format }: { title: string; rows: {value:number;operating:number}[]; format: (n: number) => string }) {
  const max = Math.max(1,...rows.map(r=>Math.abs(r.operating)));
  return <section className="pe-panel"><h3>{title}</h3><p>Net operating result per month; all other inputs held constant.</p>
    <table className="pe-sensitivity"><caption className="pe-sr">{title}: input and monthly result</caption><thead><tr><th scope="col">Input</th><th scope="col">Result</th><th scope="col">Relative size</th></tr></thead>
      <tbody>{rows.map(r=><tr key={r.value}><th scope="row">{format(r.value)}</th><td className={r.operating < 0 ? 'pe-loss' : ''}>{usd(r.operating)}</td>
        <td><span aria-hidden="true" className={`pe-bar ${r.operating < 0 ? 'pe-bar-loss' : ''}`} style={{width:`${Math.abs(r.operating)/max*100}%`}} /></td></tr>)}</tbody></table>
  </section>;
}
const initialTrades: NetworkTrade[] = [
  {id:'material',label:'Raw material specialist',price:300,inputCost:0,ownCost:180,leakage:0,buyerTradeId:'component'},
  {id:'component',label:'Component producer',price:700,inputCost:300,ownCost:200,leakage:0,buyerTradeId:'assembly'},
  {id:'assembly',label:'Assembly / final customer',price:1000,inputCost:700,ownCost:150,leakage:0},
];
const recoveryTrade: NetworkTrade = {id:'recovery-next-cycle',label:'Recovered material / next cycle',price:150,inputCost:20,ownCost:70,leakage:0};
export function NetworkComparison({ scenario }: { scenario: Scenario }) {
  const [trades,setTrades]=useState(initialTrades);
  const [circular,setCircular]=useState(false);
  const [boundary,setBoundary]=useState('assembly');
  const [recovery,setRecovery]=useState(recoveryTrade);
  const selectedTrades=circular?[...trades,recovery]:trades;
  const hasError=selectedTrades.some(t=>[t.price,t.inputCost,t.ownCost,t.leakage].some(v=>!Number.isFinite(v)||v<0||v>1_000_000)||t.price<=0||t.leakage>1);
  const each=hasError?null:networkEconomics(scenario,selectedTrades,boundary,'eachTrade');
  const final=hasError?null:networkEconomics(scenario,selectedTrades,boundary,'finalBoundary');
  function change(id: string,key: 'price'|'inputCost'|'ownCost'|'leakage',value: number) {
    const numeric=Number.isNaN(value)?0:value;
    if(id===recoveryTrade.id) setRecovery(previous=>({...previous,[key]:numeric}));
    else setTrades(previous=>previous.map(t=>t.id===id?{...t,[key]:numeric}:t));
  }
  return <section className="pe-panel pe-network"><h2>One stage or a network of trades?</h2>
    <p>Demand-led work and producer-listed supply can connect material specialists, component producers and assemblers. Each selected offer below is a distinct synthetic payment. Prices are entered independently; the model does not optimize paths or assume perfect market efficiency.</p>
    <label className="pe-toggle"><input type="checkbox" checked={circular} onChange={e=>setCircular(e.target.checked)} /> Include a recovered-material trade for the next cycle</label>
    <SelectField label="End-customer demand measurement boundary" value={boundary} options={trades.map(t=>[t.id,t.label])} onChange={setBoundary} />
    <details><summary>Edit distinct network trades and margins</summary><p>One completed synthetic batch, outside the monthly totals above. Input costs are independent; changing a competing offer's sale price does not silently change another agreed input cost.</p>
      {selectedTrades.map(t=><fieldset key={t.id}><legend>{t.label}</legend><div className="pe-network-fields">
        <NumberField label={`${t.label}: sale value ($)`} value={t.price} min={.01} onChange={v=>change(t.id,'price',v)} />
        <NumberField label={`${t.label}: purchased inputs ($)`} value={t.inputCost} onChange={v=>change(t.id,'inputCost',v)} />
        <NumberField label={`${t.label}: own transformation cost ($)`} value={t.ownCost} onChange={v=>change(t.id,'ownCost',v)} />
        <NumberField label={`${t.label}: payment leakage`} value={t.leakage} percent onChange={v=>change(t.id,'leakage',v)} />
      </div></fieldset>)}</details>
    {hasError && <p role="alert">Use positive trade values, nonnegative costs and leakage between 0% and 100%.</p>}
    {each && final && <><div className="pe-table-wrap"><table><caption>Explicit volume boundaries for one synthetic network batch</caption><tbody>
      <tr><th scope="row">Gross distinct trade volume</th><td data-testid="network-gross">{usd(each.grossTradeVolume)}</td></tr>
      <tr><th scope="row">Paid on-platform trade volume after leakage</th><td>{usd(each.paidOnPlatform)}</td></tr>
      <tr><th scope="row">Selected end-customer demand value</th><td data-testid="network-final">{usd(each.finalCustomerValue)}</td></tr>
    </tbody></table></div>
      <p>Summing material, component and finished sales measures gross trading activity, not unique end-customer demand. A recovered-material purchase is a new trade in the next cycle; the original payment is never charged again.</p>
      <div className="pe-table-wrap" tabIndex={0} role="region" aria-label="Network fee policy comparison, scroll horizontally if needed"><table><caption>Illustrative fee policies — owner decision pending</caption><thead><tr><th scope="col">One batch</th><th scope="col">Fee on each distinct trade</th><th scope="col">Fee at selected boundary only</th></tr></thead><tbody>
        <tr><th scope="row">Platform fee earned</th><td data-testid="network-each-fee">{usd(each.platformFee)}</td><td data-testid="network-final-fee">{usd(final.platformFee)}</td></tr>
        <tr><th scope="row">Fee charged to producers</th><td>{usd(each.producerFees)}</td><td>{usd(final.producerFees)}</td></tr>
        <tr><th scope="row">External buyer fee/payment additions</th><td>{usd(each.externalBuyerAdditions)}</td><td>{usd(final.externalBuyerAdditions)}</td></tr>
        <tr><th scope="row">Sum of modeled producer margins</th><td>{usd(each.producerMargin)}</td><td>{usd(final.producerMargin)}</td></tr>
        <tr><th scope="row">Platform after per-trade payment/payout costs</th><td>{usd(each.platformPaymentContribution)}</td><td>{usd(final.platformPaymentContribution)}</td></tr>
      </tbody></table></div>
      <div className="pe-table-wrap" tabIndex={0} role="region" aria-label="Producer margin comparison, scroll horizontally if needed"><table><caption>Producer margin impact by stage</caption><thead><tr><th scope="col">Selected trade</th><th scope="col">Fee each trade</th><th scope="col">Fee boundary only</th></tr></thead><tbody>
        {each.rows.map((row,i)=><tr key={row.id}><th scope="row">{row.label}</th><td>{usd(row.producerMargin)}</td><td>{usd(final.rows[i]!.producerMargin)}</td></tr>)}
      </tbody></table></div>
      <p>Uses the active scenario's fee, payer, card/ACH and per-payout pricing. All network payments are completed; refunds, risk, monthly account fees, support, acquisition and fixed operations are excluded here. Other off-platform payment costs are unknown and excluded. Producer margin = sale − purchased goods inputs − own costs − applicable platform/payment costs, including buyer additions on linked upstream purchases. Current final and next-cycle recovery buyers are outside this batch.</p>
      <p>More fee boundaries reduce margins and may encourage payment leakage. Increase a stage's leakage to see lost platform fees; it is not a forecast of behavior. Keeping trades on-platform requires demonstrated sourcing, coordination, records or service value. Competing offers can change the path; no path or circular recovery rate is guaranteed.</p>
    </>}
  </section>;
}
export interface EconomicsModelProps { initialScenario?: Scenario; onScenarioChange?: (scenario: Scenario) => void; }
export function EconomicsModel({ initialScenario = baseScenario, onScenarioChange }: EconomicsModelProps) {
  const [saved, setSaved] = useState<Record<string,Scenario>>({ ...scenarios, [initialScenario.name]: initialScenario });
  const [selected, setSelected] = useState(initialScenario.name);
  const s = saved[selected] ?? initialScenario;
  const errors = validateScenario(s);
  function change(next: Scenario) { setSaved(previous=>({...previous,[selected]:next})); onScenarioChange?.(next); }
  function field(key: NumericKey, label: string, hint?: string, min=0) {
    return <NumberField key={key} label={label} value={s[key]} percent={percentKeys.has(key)} min={min} hint={hint}
      step={['orders','suppliers','rounds','sellers','payoutsPerSeller'].includes(key) ? '1' : 'any'}
      onChange={value=>change({...s,[key]:Number.isNaN(value) ? 0 : value})} />;
  }
  const r = errors.length ? null : evaluate(s);
  const be = errors.length ? null : breakEven(s);
  return <div className="pe-app">
    <header className="pe-header"><span className="pe-brand">VISTA VERDE / COMMERCIAL EXPLORATION</span><span className="pe-pill">Synthetic · USD · Monthly</span></header>
    <main>
      <div className="pe-intro"><span className="pe-eyebrow">Post a need. Agree the work. Producers fulfill.</span><h1>What would the work order board earn?</h1>
        <p>A posted budget is a request, not funded work. Follow accepted commitments through payment, completion and earned fees. Buyers can post needs; producers can list materials or components. Outputs can become inputs to another stage or cycle.</p>
        <p className="pe-disclosure">Every scenario is illustrative, editable and unapproved. No traction, pricing forecast, real balances or payments. Provider prices checked October 12, 2026; verify before any commercial decision.</p></div>
      <div className="pe-toolbar" role="group" aria-label="Scenario selection">{Object.keys(saved).map(name=><button key={name} aria-pressed={selected===name}
        onClick={()=>setSelected(name)}>{name}</button>)}<button onClick={()=>change(scenarios[selected] ?? initialScenario)}>Reset this scenario</button></div>
      <div className="pe-layout"><aside aria-label="Economics assumptions">
        <Group title="1. Work orders & platform fee" open>
          {field('orders','Posted work orders per month','Synthetic needs, before acceptance')}{field('aov','Average posted budget ($)','Goods budget only; not escrow or available funds',.01)}
          {field('acceptanceRate','Work orders reaching agreement','Explicitly accepted producer commitments')}{field('fillRate','Contracted share of each budget','Partial/multi-producer agreements')}
          {field('paidShare','Contracted value paid this month','Milestone/partial payments; no payment inferred from a budget')}{field('completionShare','Paid net value completed this month','Completion does not itself prove payment')}
          {field('leakage','Off-platform payment leakage','Accepted work orders whose payment leaves the board')}
          <SelectField label="Platform fee basis (owner decision)" value={s.feeBasis} options={ [['completed','Completed paid goods value'],['paid','Paid goods value']] }
            onChange={v=>change({...s,feeBasis:v as Scenario['feeBasis']})} />
          {field('takeRate','Platform percentage')}{field('feeFixed','Platform fixed fee per order ($)')}{field('feeCap','Platform fee cap ($)','0 = uncapped; fee never exceeds funded goods value')}
          <SelectField label="Who pays the platform fee?" value={s.commissionPayer} options={ [['seller','Seller deduction'],['buyer','Buyer addition']] }
            onChange={v=>change({...s,commissionPayer:v as Scenario['commissionPayer']})} />
          <SelectField label="Who pays processing?" value={s.processingPayer} options={ [['platform','Platform absorbs'],['seller','Seller deduction'],['buyer','Buyer reimbursement']] }
            onChange={v=>change({...s,processingPayer:v as Scenario['processingPayer']})} />
          {field('cardShare','Card share','Remaining payments use ACH; same mix by value and count')}
        </Group>
        <Group title="2. Suppliers, charges & payouts">
          {field('suppliers','Suppliers per order',undefined,1)}{field('rounds','Payment rounds per order','Separate milestone charges, not card multi-capture',1)}
          <SelectField label="Charge pattern" value={s.chargeMode} options={ [['combined','Combined charge → seller transfers'],['perSupplier','Separate charge per supplier']] }
            onChange={v=>change({...s,chargeMode:v as Scenario['chargeMode']})} />
          {field('sellers','Payout-active seller cohort',undefined,1)}{field('payoutsPerSeller','Scheduled payouts per seller/month','1 monthly, 4 weekly, 30 daily; bounded by allocations',1)}
        </Group>
        <Group title="3. Payment-provider costs">
          <p className="pe-group-note">Stripe US list-price baseline: platform handles pricing. Changing payer does not switch the provider contract. Buyer reimbursement is a scenario, subject to terms and law.</p>
          {field('cardRate','Card percentage')}{field('cardFixed','Card fixed fee per charge ($)')}{field('achRate','ACH percentage')}{field('achFixed','ACH fixed fee per charge ($)')}{field('achCap','ACH cap per charge ($)','0 = uncapped')}
          {field('activeAccountFee','Monthly active-account fee ($)')}{field('payoutRate','Payout percentage')}{field('payoutFixed','Payout fixed fee ($)')}{field('routingRate','Funds routing/platform percentage','Separate line on current Connect pricing; confirm quote')}
          {field('providerMonthly','Other provider monthly costs ($)','Unknown/negotiated costs; 0 means excluded')}{field('verificationShare','ACH orders needing new verification')}{field('verificationFee','Bank verification fee ($)')}
        </Group>
        <Group title="4. Refunds, disputes & losses">
          {field('refundRate','Refunded goods share','Full-equivalent refunds before disputes; fee returned pro rata')}
          {field('cardDisputeRate','Card dispute rate','Share of nonrefunded card charges')}{field('contestShare','Card disputes contested')}{field('winRate','Win rate on contested card disputes')}
          {field('disputeFee','Card dispute received fee ($)')}{field('counterFee','Card dispute countered fee ($)','Returned only when won')}
          {field('achReturnRate','ACH late return/dispute rate','After initial success; no network-win credit modeled')}{field('achReturnFee','ACH event fee ($)','$15 disputed / $4 failed published; use your event mix')}
          {field('recoveryRate','Lost principal recovered from sellers','Contractual recovery is uncertain; fee revenue still reversed')}{field('fraudRate','Additional non-dispute fraud loss','Disjoint from dispute principal, net goods basis')}
        </Group>
        <Group title="5. Support, acquisition & fixed costs">
          {field('supportPerOrder','Support per funded order ($)')}{field('supportPerRefund','Extra support per refund ($)')}{field('supportPerDispute','Extra support per dispute/return ($)')}
          {field('ordersPerBuyer','Orders per buyer/month','Illustrative repeat frequency, not lifetime value',1)}{field('newBuyerShare','Share of buyers newly acquired')}{field('acquisitionCost','Cost per new buyer ($)','Marketing + attributable founder/sales time')}{field('fixedCost','Fixed operating costs/month ($)','Include founder labor, legal/accounting, software; no capital source assumed')}
        </Group>
        <Group title="6. Cash timing (separate from profit)">
          {field('cardDays','Card settlement lag (days)','Illustrative average; includes no bank-calendar guarantee')}{field('achDays','ACH settlement lag (days)')}{field('payoutLagDays','Supplier payout queue (days)')}
          {field('reserveRate','Reserve planning share')}{field('reserveDays','Reserve coverage window (days)')}
        </Group>
      </aside><div className="pe-results">
        {errors.length > 0 && <div role="alert" className="pe-warning"><h2>Adjust these assumptions</h2><ul>{errors.map(e=><li key={e}>{e}</li>)}</ul></div>}
        {r && be && <>
          <div className="pe-metrics" aria-live="polite" aria-atomic="true">
            <Metric label="Paid goods volume / GMV" value={usd(r.gmv)} detail={`${count(r.paidOrders)} paying work orders · ${count(r.charges)} charges`} />
            <Metric label="Earned platform revenue*" value={usd(r.revenue)} detail={`Assumed earned on ${s.feeBasis} value, net of reversals`} />
            <Metric label="Contribution" value={usd(r.contribution)} negative={r.contribution<0} detail="After payment, risk, support and acquisition costs" />
            <Metric label="Net operating result" value={usd(r.operating)} negative={r.operating<0} detail={`Contribution less ${usd(s.fixedCost)} fixed costs`} />
          </div>
          <section className="pe-panel"><h2>A budget becomes value in stages</h2><div className="pe-table-wrap"><table><caption>Monthly work order value — distinct stages, never added together</caption><tbody>
            <tr><th scope="row">Posted budget</th><td>{usd(r.postedBudget)}</td></tr><tr><th scope="row">Accepted contracted value</th><td>{usd(r.contractedValue)}</td></tr>
            <tr><th scope="row">Paid goods GMV (before reversals)</th><td>{usd(r.gmv)}</td></tr><tr><th scope="row">Completed net paid goods value</th><td>{usd(r.completedValue)}</td></tr>
            <tr><th scope="row">Earned platform fee</th><td>{usd(r.revenue)}</td></tr></tbody></table></div>
            <p>Fee basis is an owner decision; no fee is charged on posted budgets. This model follows one billable cohort. Raw-material purchases inside a producer's work are not automatically added to GMV or charged again. Model them separately only after deciding whether they are distinct billable trades.</p></section>
          <section className="pe-decision pe-panel"><h2>{r.operating >= 0 ? 'This scenario covers the modeled costs.' : 'This scenario needs a better margin or lower costs.'}</h2>
            <p>Effective retained fee: <strong>{pct(r.gmv > 0 ? r.revenue/r.gmv : 0)}</strong> of captured GMV. Platform fees and reimbursements are separate.</p>
            <p>Processing-only surplus: <strong>{usd(r.processorOnly)}</strong>. This covers payment cost only; it does not mean the business is profitable.</p>
            <p data-testid="break-even">{be.status === 'reachable' ? <>Whole-business break-even: <strong>{usd(be.gmv)} monthly paid GMV</strong>, from {count(be.orders)} posted work orders at this budget and mix.</>
              : be.status === 'negative' ? <><strong>No volume break-even.</strong> Additional posted work orders have nonpositive contribution ({usd(be.marginalContribution)} per order). More volume cannot fix this cost structure.</>
              : be.status === 'noFunding' ? <>No funded activity. Break-even is undefined.</> : <>Break-even exceeds the 10-million-order exploration limit.</>}</p>
            <small>Break-even freezes the seller cohort, costs, leakage, repeat frequency and fee rules. Real costs can grow with volume.</small>
            {r.sellerShortfall>0 && <p className="pe-warning">Seller fees exceed available proceeds by {usd(r.sellerShortfall)}. The platform absorbs that shortfall in this model.</p>}
          </section>
          <Waterfall result={r} />
          <section className="pe-panel"><h2>Follow one paying work order</h2><p>Average goods paid: {usd(r.fundedAov)}. {s.suppliers} equal producer allocations, {s.rounds} payment round(s); {s.chargeMode === 'combined' ? 'one combined charge per round' : 'one charge per producer per round'}. The platform fee uses {s.feeBasis} goods value, calculated once per work order and divided across charges.</p>
            <div className="pe-table-wrap"><table><caption>Monthly money movements and costs</caption><tbody>{([
              ['Posted budget (not GMV)',r.postedBudget],['Accepted contracted value',r.contractedValue],['Paid goods GMV',r.gmv],['Completed net paid goods',r.completedValue],['Refunded goods',r.refunds],['Lost disputed goods',r.disputedMerchandise],['Net paid goods GMV',r.netGMV],
              ['Buyer cash collected (includes additions)',r.buyerCollected],['Gross platform fees',r.grossRevenue],['Retained platform revenue',r.revenue],
              ['All processing fees',r.processing],['Processing reimbursements retained',r.processingRecovery],['Processing on refunded payments (already included)',r.refundProcessing],
              ['Supplier payout volume before later chargebacks',r.payoutVolume],['Payout cost',r.payoutCost],['Routing/platform cost',r.routingCost],['Active-account cost',r.accountCost],['Verification cost',r.verificationCost],
              ['Principal exposed after lost disputes',r.principalAtRisk],['Unrecovered principal loss',r.principalLoss],['Customer acquisition',r.acquisition],
            ] as [string,number][]).map(([k,v])=><tr key={k}><th scope="row">{k}</th><td>{usd(v)}</td></tr>)}</tbody></table></div>
            <p>{count(r.allocations)} supplier allocations · {count(r.activeSellers)} estimated active sellers · {count(r.payouts)} bank payouts · {count(r.newBuyers)} acquired buyers. Fractional counts are expectations.</p>
          </section>
          <section className="pe-panel"><h2>Cash can be tight even when profit is positive</h2><div className="pe-cash">
            <Metric label="Pending settlement" value={usd(r.cash.pendingSettlement)} detail="Average buyer cash awaiting availability" />
            <Metric label="Supplier payout queue" value={usd(r.cash.supplierQueue)} detail="Average payable balance at illustrative lag" />
            <Metric label="Reserve planning buffer" value={usd(r.cash.reserveBuffer)} detail="Own liquidity assumption; no provider reserve quote" />
            <Metric label="Monthly gross dispute exposure" value={usd(r.cash.disputedGross)} detail="Before wins/recovery; can be debited immediately" /></div>
            <p>These measures overlap and must not be added. Supplier money is owed to suppliers; it cannot fund operations. Payout timing is not escrow, a funding guarantee or a permission to hold money.</p></section>
          <div className="pe-chart-grid">
            <SensitivityChart title="How much does the take rate matter?" rows={sensitivity(s,'takeRate',[0,.01,.02,.03,.04,.05,.06,.08])} format={pct} />
            <SensitivityChart title="What changes with posted budget?" rows={sensitivity(s,'aov',[10,50,250,1000,5000,20000])} format={usd} />
            <SensitivityChart title="Does more volume help?" rows={sensitivity(s,'orders',[0,...Array.from(new Set([.25,.5,1,2,4].map(x=>Math.min(10_000_000,Math.max(1,Math.round(s.orders*x))))))])} format={count} />
          </div>
          <NetworkComparison scenario={s} />
        </>}
        <section className="pe-panel"><h2>What needs evidence next?</h2><ol><li>Who accepts the platform fee and payment cost?</li><li>Typical funded order value, supplier count and ACH willingness.</li><li>Repeat purchases and orders lost to off-platform payment.</li><li>Acquisition effort and support time per completed deal.</li><li>Returns, disputes, recovery rights and cash required before payout.</li></ol>
          <p>Minimum experiment: replay a small synthetic set of stocked-goods allocations through a provider sandbox, measure reconciliation and support effort, then test a clearly disclosed fee quote with prospective participants. Real payments require a separate decision.</p></section>
        <details className="pe-panel"><summary>Sources, assumptions & limitations</summary>
          <p>Baseline: US domestic USD, Stripe Connect with platform handling pricing. Published card 2.9% + $0.30; ACH 0.8% capped at $5; active account $2/month; payout 0.25% + $0.25; separate routing/platform 0.25%. ACH Financial Connections verification $1.50 when used. Contract applicability and all extra charges need verification.</p>
          <ul><li><a href="https://stripe.com/pricing">Stripe Payments pricing</a> · <a href="https://stripe.com/connect/pricing">Connect pricing</a> · <a href="https://stripe.com/pricing/local-payment-methods">ACH, verification and return pricing</a></li>
            <li><a href="https://docs.stripe.com/refunds">Refund fees</a> · <a href="https://docs.stripe.com/disputes/how-disputes-work">Disputes</a> · <a href="https://docs.stripe.com/connect/separate-charges-and-transfers">Split funds flow</a></li></ul>
          <p>Planning net revenue assumes Vista Verde is an agent earning a service fee on the chosen paid/completed basis this month. Fee timing and any nested raw-material charges require an owner decision; an accountant must determine principal/agent treatment and when revenue is earned. All behavioral inputs and cash buffers are assumptions. The ACH event fee defaults to the published disputed-payment price; late failure fees or a mixed event cohort differ.</p>
          <p>Equal allocation sizes, uniform rail mix, steady monthly cohorts and full-equivalent refunds simplify reality. Reimbursements are returned pro rata on refunded/lost payments. Provider processing fees stay charged once. Refund support is per order equivalent; disputes are per charge. Refunds precede payouts; chargebacks follow them. Unequal fills, refunds after payout, initial failed attempts, tax/shipping processing, international/FX, optional tools, tax filing costs, financing, time-varying cohorts and payout holidays are excluded; budget unknown costs explicitly. No currency conversion, tax calculation or legal conclusion.</p>
        </details>
      </div></div>
    </main><footer>Decision aid only · Private local preview · No provider connection</footer>
  </div>;
}
