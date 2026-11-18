import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { RecordCards,WorkspaceHeader,SessionRecovery,Terms } from '../../apps/web/components.tsx';
import type { Workspace } from '../../packages/contracts/src/views.ts';
const workspace: Workspace = { role:'producer',actorId:'producer-a',organizationId:'producer-a-org',funds:{ currency:'USD',balanceMinorUnits:100000,reservedMinorUnits:0,availableMinorUnits:99900 },terms:[],specifications:[],records:[],collection:'commitments',nextCursor:null };
test('React renders untrusted persisted titles as text and keeps IDs as encoded navigation references',() => {
  const html = renderToStaticMarkup(<RecordCards records={[{ id:'opaque/a',title:'<img src=x onerror=alert(1)>',state:'draft',slotCount:0,requirementRevision:1 }]}/>);
  assert.equal(html.includes('<img'),false);assert.match(html,/&lt;img/);assert.match(html,/href="#requirement\/opaque%2Fa"/);
});
test('Busy React controls prevent identity changes while a write owns the request; buyer-only draft navigation stays absent',() => {
  const html = renderToStaticMarkup(<WorkspaceHeader workspace={workspace} session={{ signedIn:true,csrf:'nonce',persona:'producer-a',personas:[{ id:'producer-a',label:'Producer' }] }} hash="#commitments" blocked onSwitch={() => undefined} onRetry={() => undefined}/>);
  assert.match(html,/<select[^>]*disabled/);assert.match(html,/<button id="logout"[^>]*disabled/);assert.equal(html.includes('Create draft'),false);
  assert.match(html,/\$999\.00/);assert.match(html,/aria-current="page">Your commitments/);
});
test('React frozen terms preserve committed hold/release boundary and distinct price recipient',() => {
  const html = renderToStaticMarkup(<Terms slot={{ termsId:'synthetic-v1',termsRevision:1,requirementRevision:2,fixtureTerms:{ synthetic:true,recipientAccount:'slot-price-suspense',compensationTrigger:'accepted_full_slot',disposition:'unpurchased_release_only' } }}/>);
  assert.match(html,/Purchased compensation stays reserved/);assert.match(html,/slot-price-suspense/);assert.match(html,/No transport charge is included/);
});
test('Denied workspace recovery keeps session controls without projecting unauthorized funds or records',() => {
  const html = renderToStaticMarkup(<SessionRecovery session={{ signedIn:true,csrf:'nonce',persona:'buyer-agent',personas:[{ id:'buyer-agent',label:'Buyer agent' },{ id:'buyer',label:'Buyer human' }] }} blocked={false} onSwitch={() => undefined} onRetry={() => undefined}/>);
  assert.match(html,/id="persona"/);assert.match(html,/id="logout"/);assert.match(html,/Buyer human/);
  assert.equal(html.includes('Your synthetic funds'),false);assert.equal(html.includes('class="metric"'),false);assert.equal(html.includes('class="card"'),false);
});
