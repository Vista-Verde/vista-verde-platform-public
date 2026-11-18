import { useId } from 'react';

export type Audience = 'overview' | 'buyers' | 'suppliers' | 'producers' | 'backers';

export const audiencePitches: Record<Audience, {
  label: string; story: string; title: string; benefit: string; bring: string; why: string; ask: string; boundary: string;
}> = {
  overview: {
    label: 'Overview', story: 'overview', title: 'Two paths. One production network.',
    benefit: 'Find suitable goods, or find the expertise to make them.',
    bring: 'Available goods, production expertise, buyer needs and support.',
    why: 'Clearer terms and responsibilities across independent participants.',
    ask: 'Start with one real workflow.', boundary: 'Illustrative network. No pilot or vertical has been selected.',
  },
  buyers: {
    label: 'Buyers', story: 'buyers', title: 'Buyers', benefit: 'Get clearer terms for the goods you need.',
    bring: 'Your need, a budget limit and acceptance criteria.', why: 'Clear terms and fewer unresolved handoffs.',
    ask: 'Start with one recent buying task.', boundary: 'A short walkthrough. No order or spend requested.',
  },
  suppliers: {
    label: 'Suppliers', story: 'material-and-component-suppliers', title: 'Material and component suppliers',
    benefit: 'Put suitable supply in front of the right buyers.',
    bring: 'Specifications, availability and handoff terms.', why: 'Relevant demand with less clarification work.',
    ask: 'Show us one inquiry and its missing details.', boundary: 'No stock import, integration or inventory commitment.',
  },
  producers: {
    label: 'Producers', story: 'producers', title: 'Producers', benefit: 'Choose suitable work and keep the scope clear.',
    bring: 'Process expertise, feasibility and a quote.', why: 'Work that fits your process, with fewer missing inputs.',
    ask: 'Walk us through one quote or scope change.', boundary: 'Giving feedback does not commit your production capacity.',
  },
  backers: {
    label: 'Backers & partners', story: 'backers-and-network-partners', title: 'Backers and network partners',
    benefit: 'Help test whether better coordination creates value.',
    bring: 'Operator introductions, feedback or scoped capital.', why: 'Evidence to assess a useful, repeatable business.',
    ask: 'Challenge one pilot idea or make an introduction.', boundary: 'Any capital would fund a defined test budget. No raise is established.',
  },
};

export const audienceStoryHref = (audience: Audience) => `./?path=/story/platform-audience-pitches--${audiencePitches[audience].story}`;

const roles = [
  { key: 'suppliers', title: ['Material and', 'component', 'suppliers'], action: ['Offer inputs'] },
  { key: 'producers', title: ['Producers'], action: ['Buy inputs', 'Sell outputs'] },
  { key: 'buyers', title: ['Buyers'], action: ['Specify needs', 'Approve terms'] },
] as const;

function NetworkDiagram({ audience, mobile, id }: { audience: Audience; mobile: boolean; id: string }) {
  const solid = `${id}-goods-${mobile ? 'mobile' : 'wide'}`;
  const dashed = `${id}-needs-${mobile ? 'mobile' : 'wide'}`;
  return <svg className={`pitch-diagram pitch-diagram--${mobile ? 'mobile' : 'wide'}`}
    viewBox={mobile ? '0 0 360 910' : '0 0 1120 530'} aria-hidden="true" focusable="false">
    <defs>
      <marker id={solid} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0L8 4L0 8Z" className="pitch-arrowhead" /></marker>
      <marker id={dashed} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0L8 4L0 8Z" className="pitch-need-arrowhead" /></marker>
    </defs>
    {mobile ? <>
      <text className="pitch-edge-entry" x="180" y="24" textAnchor="middle">Available supply</text>
      <path className="pitch-goods-edge" d="M180 38V90" markerEnd={`url(#${solid})`} />
      <path className="pitch-goods-edge" d="M180 240V320" markerEnd={`url(#${solid})`} />
      <path className="pitch-goods-edge" d="M180 450V530" markerEnd={`url(#${solid})`} />
      <text className="pitch-mobile-edge-label" x="198" y="287">Inputs</text>
      <text className="pitch-mobile-edge-label" x="198" y="497">Output</text>
      <path className="pitch-needs-edge" d="M80 595H29V165H80" markerEnd={`url(#${dashed})`} />
      <path className="pitch-needs-edge" d="M29 385H80" markerEnd={`url(#${dashed})`} />
      <rect className="pitch-label-ground" x="0" y="253" width="62" height="63" />
      <text className="pitch-mobile-side-label" x="29" y="270" textAnchor="middle"><tspan x="29">Needs</tspan><tspan x="29" dy="19">&amp; work</tspan><tspan x="29" dy="19">orders</tspan></text>
      <path className="pitch-goods-edge" d="M280 165H330V595H280" markerEnd={`url(#${solid})`} />
      <rect className="pitch-label-ground" x="298" y="365" width="62" height="48" />
      <text className="pitch-mobile-side-label" x="330" y="385" textAnchor="middle"><tspan x="330">Direct</tspan><tspan x="330" dy="20">goods</tspan></text>
      <text className="pitch-edge-entry" x="180" y="715" textAnchor="middle">Buyer need</text>
      <path className="pitch-goods-edge" d="M180 694V660" markerEnd={`url(#${solid})`} />
    </> : <>
      <text className="pitch-edge-entry" x="185" y="30" textAnchor="middle">Available supply</text>
      <text className="pitch-edge-entry" x="935" y="30" textAnchor="middle">Buyer need</text>
      <path className="pitch-goods-edge" d="M185 44V130" markerEnd={`url(#${solid})`} />
      <path className="pitch-goods-edge" d="M935 44V130" markerEnd={`url(#${solid})`} />
      <text className="pitch-edge-label" x="560" y="66" textAnchor="middle">Needs and work orders</text>
      <path className="pitch-needs-edge" d="M935 82H185" markerEnd={`url(#${dashed})`} />
      <path className="pitch-needs-edge" d="M560 82V130" markerEnd={`url(#${dashed})`} />
      <path className="pitch-goods-edge" d="M320 222H425" markerEnd={`url(#${solid})`} />
      <path className="pitch-goods-edge" d="M695 222H800" markerEnd={`url(#${solid})`} />
      <text className="pitch-edge-label" x="372" y="207" textAnchor="middle">Inputs</text>
      <text className="pitch-edge-label" x="748" y="207" textAnchor="middle">Output</text>
      <path className="pitch-goods-edge" d="M185 310V358H935V310" markerEnd={`url(#${solid})`} />
      <text className="pitch-direct-label" x="560" y="345" textAnchor="middle">Existing goods can go straight to buyers</text>
    </>}
    {roles.map((role, index) => {
      const x = mobile ? 80 : 50 + index * 375;
      const y = mobile ? [90, 320, 530][index]! : 130;
      const width = mobile ? 200 : 270;
      const height = mobile && index > 0 ? 130 : mobile ? 150 : 180;
      const selected = audience === role.key;
      const titleY = y + (mobile ? role.title.length > 1 ? 46 : 43 : role.title.length > 1 ? 55 : 75);
      const actionY = y + (mobile ? role.title.length > 1 ? 127 : 78 : role.title.length > 1 ? 155 : 122);
      return <g key={role.key} className={`pitch-node${selected ? ' pitch-node--selected' : ''}`} data-role={role.key}>
        <rect x={x} y={y} width={width} height={height} rx="16" />
        {selected && <text className="pitch-you" x={x + width / 2} y={y + 18} textAnchor="middle">Your role</text>}
        <text className="pitch-node-title" x={x + width / 2} y={titleY} textAnchor="middle">
          {role.title.map((line, n) => <tspan key={line} x={x + width / 2} dy={n ? mobile ? 26 : 30 : 0}>{line}</tspan>)}
        </text>
        <text className="pitch-node-action" x={x + width / 2} y={actionY} textAnchor="middle">
          {role.action.map((line, n) => <tspan key={line} x={x + width / 2} dy={n ? mobile ? 26 : 30 : 0}>{line}</tspan>)}
        </text>
      </g>;
    })}
    <path className="pitch-support-edge" d={mobile ? 'M40 744V758H320V744M180 758V780' : 'M60 391V409H1060V391M560 409V428'} />
    <g className={`pitch-node pitch-backer${audience === 'backers' ? ' pitch-node--selected' : ''}`} data-role="backers">
      <rect x={mobile ? 40 : 60} y={mobile ? 780 : 428} width={mobile ? 280 : 1000} height={mobile ? 110 : 82} rx="16" />
      {audience === 'backers' && <text className="pitch-you" x={mobile ? 180 : 130} y={mobile ? 797 : 448} textAnchor="middle">Your role</text>}
      <text className="pitch-backer-title" x={mobile ? 180 : 560} y={mobile ? 823 : 462} textAnchor="middle">
        {mobile ? <><tspan x="180">Backers and</tspan><tspan x="180" dy="26">network partners</tspan></> : 'Backers and network partners'}
      </text>
      <text className="pitch-backer-action" x={mobile ? 180 : 560} y={mobile ? 875 : 490} textAnchor="middle">{mobile ? 'Introductions and scoped support' : 'Offer introductions and support defined tests'}</text>
    </g>
  </svg>;
}

export function AudiencePitch({ audience = 'overview' }: { audience?: Audience }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const pitch = audiencePitches[audience];
  const description = `Physical goods: material and component suppliers provide inputs to producers, and producers sell output to buyers. Existing goods can go directly from suppliers to buyers. Available supply enters at suppliers. Buyer needs and work orders travel back to producers and suppliers. Backers and network partners enable the network with introductions and scoped support; they are not a physical production step.${audience === 'overview' ? '' : ` Highlighted audience: ${pitch.title}.`}`;
  return <main className="pitch-root" aria-label="Vista Verde audience pitch">
    <article className="pitch-sheet">
      <header className="pitch-masthead"><span className="pitch-brand"><span aria-hidden="true" />VISTA VERDE</span><span className="pitch-status">Draft · proposed network</span></header>
      <nav className="pitch-nav" aria-label="Audience pages">
        {(Object.keys(audiencePitches) as Audience[]).map(key => <a key={key} href={audienceStoryHref(key)} target="_top" aria-current={audience === key ? 'page' : undefined}>{audiencePitches[key].label}</a>)}
      </nav>
      <header className="pitch-hero"><p className="pitch-eyebrow">{audience === 'overview' ? 'Supply-first or demand-first' : 'Your place in the network'}</p><h1>{pitch.title}</h1><p className="pitch-benefit">{pitch.benefit}</p><p className="pitch-intent">The value we are building toward.</p></header>
      <figure className="pitch-flow" aria-labelledby={`${id}-map-title`} aria-describedby={`${id}-map-description`}>
        <figcaption id={`${id}-map-title`}>Proposed agent-first marketplace</figcaption>
        <p className="pitch-sr-only" id={`${id}-map-description`}>{description}</p>
        <NetworkDiagram audience={audience} mobile={false} id={id} />
        <NetworkDiagram audience={audience} mobile id={id} />
        <div className="pitch-legend" aria-hidden="true"><span><i />Goods</span><span><i className="pitch-legend-needs" />Needs and work orders</span><span>Backers enable the network</span></div>
        <p className="pitch-example">Example only: components become countertop display pieces. No pilot or vertical selected.</p>
      </figure>
      <p className="pitch-approval">Agents coordinate. People approve commitments.</p>
      <section className="pitch-value" aria-label="Participation value">
        <div><h2>You bring</h2><p>{pitch.bring}</p></div><div><h2>Why this could help</h2><p>{pitch.why}</p></div>
      </section>
      <section className="pitch-ask" aria-label="A first conversation"><h2>{pitch.ask}</h2><p>{pitch.boundary}</p></section>
      <section className="pitch-proof" aria-label="POC and planned capabilities">
        <p><strong>Working POC</strong> Real quote, approval and status traffic with a separate simulated producer.</p>
        <p><strong>Still unproved</strong> Commercial demand, physical production, payments and authenticated remote MCP.</p>
        <details><summary>Technical proof and references</summary><p>Supply and demand records persist. Local stdio Model Context Protocol (MCP) was tested with a real client. The requester is deterministic; producer progress, prices and availability are synthetic. Optional producer recovery is experimental and disabled by default. The map shows the broader proposed network, not an operating production service.</p><div className="pitch-references"><a href="https://github.com/Vista-Verde/vista-verde-platform-public/blob/main/RUNTIME.md" target="_blank" rel="noopener noreferrer">Runtime and limits</a><a href="https://github.com/Vista-Verde/vista-verde-platform-public/blob/main/README.md" target="_blank" rel="noopener noreferrer">Public snapshot and limitations</a></div></details>
      </section>
    </article>
  </main>;
}
