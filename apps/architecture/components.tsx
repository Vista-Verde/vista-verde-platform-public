import { useId } from 'react';

type NodeId='requester'|'sourcing'|'producer'|'mcp'|'http'|'authority'|'records'|'human'|'mandates'|'future';
type Box={x:number;y:number;width:number;height:number};
const nodes:{id:NodeId;title:string;label:string;lines:string[];planned?:boolean;human?:boolean}[]=[
  {id:'requester',title:'Demand / requester agent',label:'PRIMARY ROLE · RUNNER PLANNED',lines:['Post needs and stated budgets','Discover responses; propose terms'],planned:true},
  {id:'sourcing',title:'Material-sourcing agent',label:'PRIMARY ROLE · RUNNER PLANNED',lines:['Discover independent input supply','Propose sources and input work'],planned:true},
  {id:'producer',title:'Producer / stage agents',label:'PRIMARY ROLE · RUNNER PLANNED',lines:['Respond to work; offer outputs','Buy inputs, sell components / remainder'],planned:true},
  {id:'mcp',title:'MCP adapter · local stdio',label:'IMPLEMENTED · SDK CLIENT TESTED',lines:['Typed command / query tools','No public or remote MCP endpoint']},
  {id:'http',title:'HTTP + browser workspace',label:'IMPLEMENTED · SYNTHETIC APP',lines:['Monitor and review scoped records','Manual approval / operation fallback']},
  {id:'authority',title:'One shared domain authority',label:'IMPLEMENTED · BOTH ADAPTERS',lines:['Membership, role, scope, expiry checks','Stated work budget + quantity bounds','Two-party consent; immutable revisions','Ordered locks; idempotent commands']},
  {id:'records',title:'PostgreSQL · one transaction',label:'IMPLEMENTED · SHARED RECORDS',lines:['Work orders · supply · proposals','Commitments · fulfillment · lots','Attributable audit + durable replay','Outbox intent, not delivered alerts']},
  {id:'human',title:'Human supervisor',label:'SUPERVISE · AUTHORIZE · INTERVENE',lines:['Monitor progress and frozen terms','Approve consequential commitments','Handle exceptions; retain manual control'],human:true},
  {id:'mandates',title:'Production mandates',label:'PLANNED · COMMERCIAL POLICY',lines:['Human-defined permission / spend caps','Approval escalation and exception queue'],planned:true},
  {id:'future',title:'External integration + orchestration',label:'PLANNED · NO CURRENT CONNECTION',lines:['Remote MCP / production identity; autonomous stage runners','Real payment providers and orchestration are not connected'],planned:true},
];
const desktop:Record<NodeId,Box>={
  requester:{x:40,y:24,width:350,height:126},sourcing:{x:445,y:24,width:350,height:126},producer:{x:850,y:24,width:350,height:126},
  http:{x:40,y:220,width:350,height:116},mcp:{x:445,y:220,width:350,height:116},mandates:{x:850,y:220,width:350,height:116},
  human:{x:40,y:405,width:350,height:150},authority:{x:445,y:395,width:755,height:164},records:{x:445,y:620,width:755,height:164},future:{x:40,y:835,width:1160,height:112},
};
const mobile:Record<NodeId,Box>={
  requester:{x:20,y:24,width:360,height:124},sourcing:{x:20,y:176,width:360,height:124},producer:{x:20,y:328,width:360,height:124},
  mcp:{x:20,y:510,width:360,height:120},authority:{x:20,y:680,width:360,height:170},records:{x:20,y:900,width:360,height:170},
  http:{x:20,y:1130,width:360,height:120},human:{x:20,y:1300,width:360,height:152},mandates:{x:20,y:1500,width:360,height:124},future:{x:20,y:1670,width:360,height:152},
};

export function AgentArchitectureSvg({compact=false}:{compact?:boolean}){
  const id=useId(),boxes=compact?mobile:desktop;
  const connections=compact?[
    {d:'M20 86 H8 V570 H20 M20 238 H8 M20 390 H8',planned:true},
    {d:'M200 630 V680'},{d:'M200 850 V900'},
    {d:'M200 1300 V1250'},{d:'M380 1190 H392 V766 H380'},
    {d:'M380 1562 H392 V786 H380',planned:true},
  ]:[
    {d:'M215 150 V181 H580 V220',planned:true},{d:'M620 150 V220',planned:true},{d:'M1025 150 V181 H660 V220',planned:true},
    {d:'M620 336 V395'},{d:'M820 559 V620'},
    {d:'M215 405 V336'},{d:'M390 278 H418 V477 H445'},
    {d:'M1025 336 V395',planned:true},
  ];
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox={compact?'0 0 400 1900':'0 0 1240 1010'} role="img" aria-labelledby={`${id}-title ${id}-desc`} fontFamily="system-ui, sans-serif" className={compact?'arch-svg arch-svg-mobile':'arch-svg arch-svg-desktop'}>
    <title id={`${id}-title`}>Agents operate, humans supervise — architecture diagram</title>
    <desc id={`${id}-desc`}>Primary requester, material-sourcing and producer agent roles connect through planned runners to the implemented local MCP stdio adapter. The human oversight and manual fallback use HTTP. Both adapters call one permission-checked domain authority and PostgreSQL records, audit and replay. Dashed paths are planned agent orchestration, remote transport and production mandates; solid paths are implemented synthetic commands and data. No real payment integration or production multitenant agent security is claimed.</desc>
    <defs><marker id={`${id}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10Z" fill="#94cdb8"/></marker></defs>
    <rect width="100%" height="100%" rx="18" fill="#0d1d1a"/>
    {connections.map((edge,i)=><path key={i} d={edge.d} fill="none" stroke={edge.planned?'#9babc1':'#94cdb8'} strokeWidth="2.5" strokeDasharray={edge.planned?'8 6':undefined} markerEnd={`url(#${id}-arrow)`}/>) }
    {nodes.map(node=>{
      const b=boxes[node.id],wide=!compact&&b.width>400;
      const lines=node.id==='future'&&compact?['Remote MCP + production identity','Autonomous sourcing / stage runners','No real payment provider connection']:node.lines;
      return <g key={node.id}>
        <rect {...b} rx="12" fill={node.human?'#2c3026':node.planned?'#24303c':'#14362d'} stroke={node.human?'#c7bd8f':node.planned?'#9babc1':'#79cfaf'} strokeWidth="1.6" strokeDasharray={node.planned?'7 5':undefined}/>
        <text x={b.x+18} y={b.y+25} fill={node.human?'#f0e4b7':'#d5e9e0'} fontSize="10.5" fontWeight="650" letterSpacing=".5">{node.label}</text>
        <text x={b.x+18} y={b.y+54} fill="#ffffff" fontSize={node.id==='future'&&compact?17:19} fontWeight="650">{node.title}</text>
        {lines.map((line,i)=><text key={line} x={b.x+18} y={b.y+81+i*22} fill="#d5e9e0" fontSize={wide?17:15.5}>{line}</text>)}
      </g>;
    })}
    <text x={compact?20:40} y={compact?1853:975} fill="#d5e9e0" fontSize="12">{compact?'Solid: implemented synthetic paths':'Solid: implemented synthetic paths. Dashed: planned integration / orchestration.'}</text>
    <text x={compact?20:40} y={compact?1873:995} fill="#d5e9e0" fontSize="12">{compact?'Dashed: planned integrations / orchestration':'No deployed autonomous runners, production mandate security or real payment connection is claimed.'}</text>
  </svg>;
}

export function AgentArchitecture(){
  return <main className="arch-page">
    <header className="arch-header"><p className="arch-eyebrow">VISTA VERDE · AGENT-FIRST ARCHITECTURE</p><h1>Agents operate.<br/> Humans supervise.</h1><p className="arch-intro">Agents are the primary operators for demand, sourcing and production stages. Humans monitor, authorize consequential commitments, handle exceptions and intervene through an accessible manual fallback.</p></header>
    <aside className="arch-boundary" aria-label="Architecture evidence boundary"><strong>Target roles. Implemented shared authority.</strong><p>Solid paths show the synthetic command/data implementation. Dashed paths show planned autonomous runners, production mandates, remote transport and integrations. This diagram does not claim deployed autonomous agents, real payments or production multitenant security.</p></aside>
    <figure className="arch-figure"><AgentArchitectureSvg/><AgentArchitectureSvg compact/><figcaption>Both directions meet the same authority. An agent, browser or diagram cannot grant itself permission, approval or funds.</figcaption></figure>
    <ul className="arch-legend" aria-label="Diagram legend"><li><span className="arch-line" aria-hidden="true"/>Solid: implemented synthetic path</li><li><span className="arch-line arch-line-dashed" aria-hidden="true"/>Dashed: planned integration / orchestration</li><li>Agent-role boxes describe the intended primary operators.</li></ul>
    <section aria-label="Architecture text equivalent" className="arch-text"><h2>One authority. Two ways to participate.</h2><div className="arch-flow-grid"><article><h3>Demand-led</h3><p>A requester agent posts a need and stated budget. Sourcing and producer agents identify inputs and propose frozen terms. Authorized parties agree explicitly; fulfillment and receiver acknowledgement follow. Agent runners remain planned; these commands are implemented and SDK-tested.</p></article><article><h3>Supply-led</h3><p>A material or component participant publishes independent supply. An intermediate participant buys inputs and sells outputs, with separate commitments and budgets. Manual source/stage links and conserved remainder lots support the demo; they do not buy, schedule, recurse or optimize automatically.</p></article></div>
      <div className="arch-flow-grid"><article><h3>Implemented boundary</h3><p>Local MCP stdio and the protected synthetic HTTP/browser workspace dispatch the same typed application commands. PostgreSQL enforces membership, role/object scope, grant expiry/revocation, work-budget and quantity limits, dual-party consent, ordered locks, audit and durable idempotency. Outbox entries are notification intent.</p></article><article><h3>Planned human mandate</h3><p>The buyer-agent fixture cannot confirm commitments. Producer fixture grants can confirm; the demo does not implement a universal human-approval policy. Production agent identities, monetary permission/spend mandates, approval escalation and exception handling remain planned. Simulated personas and audit logs alone prove none of that security.</p></article></div>
      <p className="arch-footnote">No public MCP endpoint is exposed at the platform URL. External transport/host compatibility and OAuth are unimplemented. Work budgets are stated intent limits, not funded escrow. Real provider payments, automatic orchestration and equipment control are not connected.</p>
      <a href="/app" target="_top">Open the protected synthetic work app →</a>
    </section>
  </main>;
}
