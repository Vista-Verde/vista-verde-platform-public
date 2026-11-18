import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHttp } from '../../apps/api/src/http.ts';
import { draft,publication,purchase } from '../../packages/db/src/fixtures.ts';
import type { Workspace } from '../../packages/contracts/src/views.ts';
import { fixture,ok,failure } from './helpers.ts';
import { browserSession,web,mcp } from './web-helpers.ts';

test('browser writes require session, Origin, CSRF, strict JSON and current grants; bearer writes stay closed',async t => {
  const f=await fixture(t); await f.publish('last'); const api=await web(f); const a=await browserSession(api.url,'producer-a'); const before=await f.snapshot();
  for (const headers of [{ origin:'https://hostile.invalid' },{ origin:'' },{ 'x-csrf-token':'' },{ 'x-csrf-token':'forged' },{ 'sec-fetch-site':'cross-site' },{ host:'rebound.invalid' }] as Record<string,string>[]) {
    const result=await a.call('purchaseSlot',purchase('last'),headers); assert.equal(result.status,403); failure(result.receipt,'FORBIDDEN');
  }
  const bearer=await fetch(`${api.url}/commands/purchaseSlot`,{ method:'POST',headers:{ authorization:`Bearer ${f.token('producer-a')}`,'content-type':'application/json' },body:JSON.stringify(purchase('last')) }); assert.equal(bearer.status,403);
  failure((await a.call('purchaseSlot',{ ...purchase('last'),actorId:'producer-b',funded:true })).receipt,'VALIDATION_FAILED');
  const plain=await a.call('purchaseSlot',purchase('last'),{ 'content-type':'text/plain' }); assert.equal(plain.status,400);
  const large=await a.call('purchaseSlot',{ padding:'x'.repeat(65537) }); assert.equal(large.status,400);
  assert.deepEqual(await f.snapshot(),before);
  await f.pool.query('UPDATE grants SET revoked=true WHERE id=$1',[f.context('producer-a').grantId]); const revoked=await f.snapshot();
  const result=await a.call('purchaseSlot',purchase('last')); assert.equal(result.status,401); failure(result.receipt,'UNAUTHENTICATED'); assert.deepEqual(await f.snapshot(),revoked);
});

test('fixture exchange resists login CSRF, arbitrary roles, session fixation and logout replay; assets enforce CSP',async t => {
  const f=await fixture(t); const api=await web(f); const bootstrap=await fetch(`${api.url}/session`); const boot=await bootstrap.json(); const cookie=bootstrap.headers.get('set-cookie')!;
  assert.match(cookie,/HttpOnly/); assert.match(cookie,/SameSite=Strict/);
  for (const [body,headers,status] of [
    [{ persona:'operator' },{ origin:api.url,'x-csrf-token':boot.csrf },403],
    [{ persona:'buyer',actorId:'operator' },{ origin:api.url,'x-csrf-token':boot.csrf },400],
    [{ persona:'buyer' },{ origin:'https://hostile.invalid','x-csrf-token':boot.csrf },403],
    [{ persona:'buyer' },{ origin:api.url,'x-csrf-token':'wrong' },403]
  ] as [unknown,Record<string,string>,number][]) {
    const response=await fetch(`${api.url}/session`,{ method:'POST',headers:{ cookie,'content-type':'application/json',...headers },body:JSON.stringify(body) }); assert.equal(response.status,status);
  }
  const a=await browserSession(api.url,'buyer');
  const logged=await fetch(`${api.url}/session`,{ method:'DELETE',headers:a.headers }); assert.equal(logged.status,200); assert.notEqual(logged.headers.get('set-cookie')!.split(';')[0],a.cookie);
  assert.equal((await a.call('getWorkspace',{})).status,401);
  const cross=await fetch(`${api.url}/session`,{ headers:{ 'sec-fetch-site':'cross-site' } }); assert.equal(cross.status,403);
  const page=await fetch(api.url); assert.equal(page.status,200); assert.match(page.headers.get('content-security-policy')!,/frame-ancestors 'none'/); assert.equal(page.headers.get('cache-control'),'no-store');
  assert.equal((await fetch(`${api.url}/style.css`)).status,200); assert.equal((await fetch(`${api.url}/app.js`)).status,200); assert.equal((await fetch(`${api.url}/../package.json`)).status,403);
  await assert.rejects(() => startHttp(f.connectionString,'local_test',{ personas:{ operator:{ label:'forged operator',token:f.token('operator') } } }));
});

test('workspace scope and pagination reveal only own persisted work and own funds',async t => {
  const f=await fixture(t); const first=await f.publish('one'); await f.publish('two'); await f.publish('other',6000);
  const a=await mcp(f,'producer-a'); const receipt=ok(await a.call('purchaseSlot',purchase('one')));
  const producer=ok(await a.call('getWorkspace',{})).data as unknown as Workspace;
  assert.equal(producer.records.length,1); assert.equal(producer.records[0]!.id,receipt.recordIds.commitmentId); assert.equal(producer.funds.balanceMinorUnits,99900);
  assert.equal((ok(await f.application.execute('getWorkspace',{},f.context('producer-b'))).data as unknown as Workspace).records.length,0);
  const other=ok(await f.application.execute('getWorkspace',{},f.context('other-buyer'))).data as unknown as Workspace; assert.equal(other.records.length,0);
  await f.pool.query('UPDATE grants SET requirement_scopes=$1 WHERE id=$2',[[first.requirementId],f.context('buyer').grantId]);
  const scoped=ok(await f.application.execute('getWorkspace',{},f.context('buyer'))).data as unknown as Workspace; assert.deepEqual(scoped.records.map(r => r.id),[first.requirementId]);
  const firstPage=ok(await f.application.execute('getWorkspace',{ limit:1 },f.context('buyer-agent'))).data as unknown as Workspace; assert.ok(firstPage.nextCursor);
  const secondPage=ok(await f.application.execute('getWorkspace',{ limit:1,cursor:firstPage.nextCursor },f.context('buyer-agent'))).data as unknown as Workspace; assert.notEqual(secondPage.records[0]!.id,firstPage.records[0]!.id);
  failure(await f.application.execute('getWorkspace',{ organizationId:'other-buyer-org' },f.context('buyer')),'VALIDATION_FAILED'); await f.reconcile();
});

test('MCP agent draft → browser human publication → browser purchase → MCP frozen receipt, workspace and audit parity',async t => {
  const f=await fixture(t); const api=await web(f); const agent=await mcp(f,'buyer-agent'); const buyer=await browserSession(api.url,'buyer');
  const created=ok(await agent.call('createRequirementDraft',draft('agent-to-web'))); const requirementId=created.recordIds.requirementId!;
  const workspace=ok((await buyer.call('getWorkspace',{})).receipt).data as unknown as Workspace; assert.equal(workspace.records[0]!.id,requirementId);
  ok((await buyer.call('publishRequirement',publication(requirementId,'web-slot'))).receipt);
  const a=await browserSession(api.url,'producer-a'); const producer=await mcp(f,'producer-a');
  const receipt=ok((await a.call('purchaseSlot',purchase('web-slot'))).receipt);
  for (const [operation,input] of [['getCommitment',{ commitmentId:receipt.recordIds.commitmentId }],['getScopedAudit',{ requirementId }],['getWorkspace',{}]] as const) {
    assert.deepEqual((await a.call(operation,input)).receipt,await producer.call(operation,input));
  }
  assert.deepEqual(await producer.call('purchaseSlot',purchase('web-slot')),receipt); await f.reconcile();
});

test('browser draft → MCP human publication and purchase → new browser sessions recover persisted commitment',async t => {
  const f=await fixture(t); const api=await web(f); const agent=await browserSession(api.url,'buyer-agent'); const buyer=await mcp(f,'buyer'); const producer=await mcp(f,'producer-a');
  const receipt=ok((await agent.call('createRequirementDraft',draft('web-to-agent'))).receipt); const requirementId=receipt.recordIds.requirementId!;
  ok(await buyer.call('publishRequirement',publication(requirementId,'agent-slot'))); const purchased=ok(await producer.call('purchaseSlot',purchase('agent-slot')));
  const fresh=await browserSession(api.url,'producer-a'); assert.deepEqual((await fresh.call('getCommitment',{ commitmentId:purchased.recordIds.commitmentId })).receipt,purchased);
  const records=(ok((await fresh.call('getWorkspace',{})).receipt).data as unknown as Workspace).records; assert.equal(records[0]!.id,purchased.recordIds.commitmentId); await f.reconcile();
});

test('browser draft split inside UTF-8 code points persists exact text for MCP readback',async t => {
  const f=await fixture(t); const api=await web(f); const agent=await browserSession(api.url,'buyer-agent'); const client=await mcp(f,'buyer-agent');
  for (const [index,character] of ['é','👷'].entries()) {
    const input={ ...draft(`utf8-${index}`),intendedUse:'Vérde 👷 · synthetic demand' };
    const bytes=Buffer.from(JSON.stringify(input)); const split=bytes.indexOf(Buffer.from(character))+1;
    assert.ok(split>0); const receipt=ok((await agent.call('createRequirementDraft',input,{},split)).receipt);
    const read=ok(await client.call('getRequirement',{ requirementId:receipt.recordIds.requirementId }));
    assert.equal((read.data.draft as { intendedUse: string }).intendedUse,input.intendedUse);
  }
  await f.reconcile();
});

test('browser competing last-slot purchase and concurrent same-key retry yield one commitment, one charge and safe release',async t => {
  const f=await fixture(t); const { requirementId }=await f.publish('last'); const api=await web(f); const a=await browserSession(api.url,'producer-a'),b=await browserSession(api.url,'producer-b');
  const results=await Promise.all([a.call('purchaseSlot',purchase('last')),b.call('purchaseSlot',purchase('last'))]); assert.equal(results.filter(r => r.receipt.ok).length,1);
  failure(results.find(r => !r.receipt.ok)!.receipt,'SLOT_UNAVAILABLE'); const winner=results[0]!.receipt.ok ? a : b;
  const replay=await Promise.all([winner.call('purchaseSlot',purchase('last')),winner.call('purchaseSlot',purchase('last'))]); assert.deepEqual(replay[0]!.receipt,replay[1]!.receipt);
  const buyer=await browserSession(api.url,'buyer'); failure((await buyer.call('withdrawUnpurchasedSlot',{ ...purchase('last','release'),expectedRecordVersion:2,reason:'Attempt' })).receipt,'COMMITMENT_DISPOSITION_REQUIRED');
  assert.equal((await f.pool.query('SELECT count(*) FROM commitments')).rows[0].count,'1'); assert.equal((await f.pool.query('SELECT count(*) FROM journal_entries')).rows[0].count,'2');
  assert.equal((ok((await buyer.call('getScopedAudit',{ requirementId })).receipt).data.events as unknown[]).length,3); await f.reconcile();
});

test('existing producer obligations remain readable after capability withdrawal, without exposing rival commitment IDs or enabling new purchases',async t => {
  const f=await fixture(t);
  const input=draft('shared-obligations'); input.lines[0]!.quantity.value=2;
  const created=ok(await f.application.execute('createRequirementDraft',input,f.context('buyer-agent'))); const requirementId=created.recordIds.requirementId!;
  const pub=publication(requirementId,'own'); pub.slots.push({ ...pub.slots[0]!,slotId:'rival' });
  ok(await f.application.execute('publishRequirement',pub,f.context('buyer')));
  const unrelated=await f.publish('unrelated');
  const own=ok(await f.application.execute('purchaseSlot',purchase('own'),f.context('producer-a')));
  const rival=ok(await f.application.execute('purchaseSlot',purchase('rival'),f.context('producer-b')));
  await f.pool.query("UPDATE capabilities SET evidence_status='self_declared' WHERE organization_id='producer-a-org'");
  const a=ok(await f.application.execute('getRequirement',{ requirementId },f.context('producer-a')));
  assert.ok(JSON.stringify(a).includes(own.recordIds.commitmentId!));
  assert.equal(JSON.stringify(a).includes(rival.recordIds.commitmentId!),false,'A competing producer cannot discover a rival commitment ID on the same requirement');
  failure(await f.application.execute('getRequirement',{ requirementId:unrelated.requirementId },f.context('producer-a')),'FORBIDDEN');
  assert.deepEqual(ok(await f.application.execute('getCommitment',{ commitmentId:own.recordIds.commitmentId },f.context('producer-a'))),own);
  failure(await f.application.execute('purchaseSlot',purchase('own'),f.context('producer-a')),'FORBIDDEN');
  failure(await f.application.execute('purchaseSlot',purchase('own','new'),f.context('producer-a')),'FORBIDDEN');
  const buyer=ok(await f.application.execute('getRequirement',{ requirementId },f.context('buyer'))); assert.ok(JSON.stringify(buyer).includes(rival.recordIds.commitmentId!));
  await f.reconcile();
});
