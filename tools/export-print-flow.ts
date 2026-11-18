import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {defaults,fixtureMesh,quote,usd} from '../apps/print-demo/model.ts';
const offer=quote(fixtureMesh(),{...defaults,units:'mm'});
const directory=resolve(process.argv[2] ?? 'docs/assets');mkdirSync(directory,{recursive:true});
// Reusable vector illustration; not a browser screenshot, provider reference,
// machine specification, test receipt or physical-execution claim.
const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1100 690" role="img" aria-labelledby="title desc">
<title id="title">Vista Verde fully mocked 3D-print example</title><desc id="desc">A local STL and mock PETG specification lead to fictional feedstock, an imaginary printer and a pretend courier. Print and delivery approvals precede simulated production. Receiver acknowledgement stays separate. The synthetic print quote is USD30 including USD4 material, with a separate USD10 courier allowance, totaling USD40. Real MCP goods commands are proved separately in disposable storage; no model runner, upload, physical execution or real money.</desc>
<rect width="1100" height="690" rx="18" fill="#f4f7f2"/><g font-family="system-ui, sans-serif" fill="#173e37">
<text x="40" y="42" font-size="13" font-weight="700" letter-spacing="2">VISTA VERDE / FIRST CONCRETE EXAMPLE / ALL PARTICIPANTS FICTIONAL</text>
<text x="40" y="89" font-size="34" font-weight="750">Local requirements → explicit approvals → simulated delivery</text>
<text x="40" y="122" font-size="17">Bundled 20 mm test cube · FDM / PETG / 1.75 mm · 1 counted part · not a user design</text>
<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8" fill="#6a8c78"/></marker></defs>
<path d="M349 268H390" stroke="#6a8c78" stroke-width="3" marker-end="url(#arrow)"/>
<path d="M710 268H751" stroke="#6a8c78" stroke-width="3" marker-end="url(#arrow)"/>
<rect x="40" y="164" width="305" height="219" rx="12" fill="white" stroke="#b8cebf"/><rect x="397" y="164" width="305" height="219" rx="12" fill="white" stroke="#b8cebf"/><rect x="754" y="164" width="305" height="219" rx="12" fill="white" stroke="#b8cebf"/>
<g stroke="#366951" stroke-width="4" fill="#e4efe7"><ellipse cx="190" cy="224" rx="49" ry="20"/><path d="M141 224V270C141 297 239 297 239 270V224"/><ellipse cx="190" cy="270" rx="49" ry="20"/><ellipse cx="190" cy="224" rx="18" ry="8" fill="white"/><path d="M145 239H235M145 252H235" fill="none"/></g>
<text x="63" y="320" font-size="20" font-weight="700">MockSpool Materials</text><text x="63" y="349" font-size="15">4 fictional spools · candidate only</text><text x="63" y="372" font-size="13">No purchase, reservation or grams/BOM</text>
<g stroke="#366951" stroke-width="4" fill="none"><path d="M486 284V206H607V284M478 290H615M490 239H603M548 209V247"/><path d="M542 246H554L548 257Z" fill="#366951"/><path d="M526 267H574V283H526Z" fill="#e4efe7"/></g>
<text x="420" y="320" font-size="20" font-weight="700">DemoForge · imaginary P1</text><text x="420" y="349" font-size="15">Mock FDM / PETG · readiness day 3</text><text x="420" y="372" font-size="13">Fictional envelope/capacity; no machine</text>
<g stroke="#366951" stroke-width="4" fill="#e4efe7"><path d="M812 241H916V218H952L982 254V282H812Z"/><path d="M925 225H950L972 250H925Z" fill="white"/><circle cx="846" cy="282" r="13" fill="white"/><circle cx="957" cy="282" r="13" fill="white"/><path d="M832 259H894"/></g>
<text x="777" y="320" font-size="20" font-weight="700">Pretend Parcel Courier</text><text x="777" y="349" font-size="15">Zone A · simulated arrival day 6</text><text x="777" y="372" font-size="13">DEMO-PARCEL-001 · no real tracking</text>
<rect x="40" y="407" width="1019" height="104" rx="10" fill="#e4efe7"/><text x="63" y="444" font-size="22" font-weight="700">${usd(offer.printTotal)} print + ${usd(offer.delivery)} separate courier = ${usd(offer.total)} illustrative customer quote</text><text x="63" y="477" font-size="17">${usd(offer.materialContribution)} material contribution is already inside the print price. Do not add a full spool or charge it again.</text>
<text x="40" y="554" font-size="17" font-weight="700">1. Human print review + mock producer consent   2. Separate human courier approval</text>
<text x="40" y="586" font-size="17">3. Simulated print / dispatch / delivered   4. Explicit human acknowledgement of simulated receipt</text>
<text x="40" y="626" font-size="15">Browser planner: local memory only, no commands or uploads. Real MCP / HTTP goods proof: separate disposable database.</text>
<text x="40" y="654" font-size="15">No model runner, provider calls, real stock, machine control or payments. Metadata checks do not prove printability.</text>
</g></svg>`;
const path=join(directory,'mock-print-flow.svg');writeFileSync(path,svg+'\n');console.log(path);
