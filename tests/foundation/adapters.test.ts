import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { BASELINE,envelope,operations } from '../../packages/contracts/src/index.ts';
import type { Operation,Envelope } from '../../packages/contracts/src/index.ts';
import { draft,publication,purchase } from '../../packages/db/src/fixtures.ts';
import { localPool } from '../../packages/db/src/postgres.ts';
import { compose } from '../../apps/api/src/composition.ts';
import { startHttp } from '../../apps/api/src/http.ts';
import { fixture,ok,failure } from './helpers.ts';

async function sdk(f: Awaited<ReturnType<typeof fixture>>,credential: string) {
  const client=new Client({ name: 'vista-verde-fixture-client',version: BASELINE },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const transport=new StdioClientTransport({ command: process.execPath,args: ['dist/apps/api/src/stdio.js'],
    env: { VV_DATABASE_URL: f.connectionString,VV_FIXTURE_MODE: 'local_test',VV_FIXTURE_CREDENTIAL: credential },stderr: 'pipe' });
  let diagnostics=''; transport.stderr?.on('data',bytes => { diagnostics+=String(bytes); });
  f.cleanupWith(async () => { await client.close(); assert.equal(diagnostics.includes(credential),false,'Credential must not appear in diagnostics'); });
  await client.connect(transport,{ timeout: 5000 });
  assert.equal(client.getNegotiatedProtocolVersion(),'2026-07-28');
  assert.equal(client.getServerVersion()?.name,'vista-verde-foundation');
  const tools=(await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(),Object.keys(operations).sort());
  for (const tool of tools) { assert.equal(tool.inputSchema.additionalProperties,false); assert.ok(tool.outputSchema); }
  const call=async (operation: Operation,input: unknown): Promise<Envelope> => {
    const response=await client.callTool({ name: operation,arguments: input as Record<string,unknown> });
    const receipt=envelope.parse(response.structuredContent); assert.equal(response.isError,!receipt.ok); return receipt;
  };
  return { client,call };
}
async function http(url: string,operation: Operation,input: unknown,credential?: string,extra: Record<string,string> = {}) {
  const body=JSON.stringify(input);
  return await new Promise<{ status: number; receipt: Envelope; cacheControl: string | undefined }>((resolve,reject) => {
    const req=request(`${url}/queries/${operation}`,{ method: 'POST',headers: {
      'content-type': 'application/json','content-length': Buffer.byteLength(body),
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),...extra
    } },response => {
      let data=''; response.on('data',bytes => { data+=String(bytes); }); response.on('error',reject);
      response.on('end',() => { try { resolve({ status: response.statusCode!,receipt: envelope.parse(JSON.parse(data)),cacheControl: response.headers['cache-control'] }); } catch (error) { reject(error); } });
    });
    req.on('error',reject); req.end(body);
  });
}

test('actual MCP v2 SDK discovery/invocation and HTTP reads share PostgreSQL records and frozen results',async t => {
  const f=await fixture(t); const agent=await sdk(f,f.token('buyer-agent'));
  const buyer=await sdk(f,f.token('buyer'));
  const a=await sdk(f,f.token('producer-a')),b=await sdk(f,f.token('producer-b'));
  const api=await startHttp(f.connectionString,'local_test'); f.cleanupWith(() => api.close());
  const created=ok(await agent.call('createRequirementDraft',draft('sdk-draft'))); const requirementId=created.recordIds.requirementId!;
  failure(await agent.call('publishRequirement',publication(requirementId,'sdk-last')),'FORBIDDEN');
  const published=ok(await buyer.call('publishRequirement',publication(requirementId,'sdk-last'))); assert.equal(published.state,'published');
  const listed=ok(await a.call('listAvailableSlots',{ requirementId,limit: 1 })); assert.equal((listed.data.slots as unknown[]).length,1);
  const races=await Promise.all([a.call('purchaseSlot',purchase('sdk-last')),b.call('purchaseSlot',purchase('sdk-last'))]);
  assert.equal(races.filter(receipt => receipt.ok).length,1); failure(races.find(receipt => !receipt.ok)!,'SLOT_UNAVAILABLE');
  const receipt=ok(races.find(receipt => receipt.ok)!); const winner=races[0]!.ok ? a : b;
  assert.deepEqual(await winner.call('purchaseSlot',purchase('sdk-last')),receipt);
  for (const [operation,input] of [
    ['getRequirement',{ requirementId }],['listAvailableSlots',{ requirementId,limit: 1 }],
    ['getCommitment',{ commitmentId: receipt.recordIds.commitmentId }],['getScopedAudit',{ requirementId,limit: 20 }]
  ] as [Operation,unknown][]) {
    const mcp=ok(await buyer.call(operation,input)); const web=await http(api.url,operation,input,f.token('buyer'));
    assert.equal(web.status,200); assert.deepEqual(web.receipt,mcp); assert.equal(web.cacheControl,'no-store');
  }
  const current=ok(await buyer.call('getRequirement',{ requirementId })); assert.equal((current.data.slots as { state: string }[])[0]!.state,'purchased');
  const before=await f.snapshot();
  const foreign=await b.call('getRequirement',{ requirementId: 'foreign' }); failure(foreign,'FORBIDDEN');
  const webForeign=await http(api.url,'getRequirement',{ requirementId: 'foreign' },f.token('producer-b'));
  assert.equal(webForeign.status,403); assert.deepEqual(webForeign.receipt,foreign);
  assert.deepEqual(await f.snapshot(),before); await f.reconcile();
});

test('HTTP fixture boundary rejects missing/forged credentials, hostile Origin/Host, writes and invalid inputs without mutation',async t => {
  const f=await fixture(t); const { requirementId }=await f.publish('last'); const api=await startHttp(f.connectionString,'local_test'); f.cleanupWith(() => api.close());
  const before=await f.snapshot();
  const cases: [Operation,unknown,string | undefined,Record<string,string>,number][] = [
    ['getRequirement',{ requirementId },undefined,{},401],
    ['getRequirement',{ requirementId },'x'.repeat(43),{},401],
    ['getRequirement',{ requirementId },f.token('buyer'),{ origin: 'https://hostile.invalid' },403],
    ['getRequirement',{ requirementId },f.token('buyer'),{ host: 'hostile.invalid' },403],
    ['purchaseSlot',purchase('last'),f.token('producer-a'),{},403],
    ['getRequirement',{ requirementId,organizationId: 'buyer-org' },f.token('buyer'),{},400],
    ['getRequirement',{ requirementId },f.token('other-buyer'),{},403]
  ];
  for (const [operation,input,credential,headers,status] of cases) {
    const result=await http(api.url,operation,input,credential,headers); assert.equal(result.status,status); assert.equal(result.receipt.ok,false);
    assert.equal(JSON.stringify(result.receipt).includes(f.token('buyer')),false);
  }
  const accepted=await http(api.url,'getRequirement',{ requirementId },f.token('buyer'),{ origin: api.url }); assert.equal(accepted.status,200);
  assert.deepEqual(await f.snapshot(),before);
  const malformed=await fetch(`${api.url}/queries/getRequirement`,{ method: 'POST',headers: { authorization: `Bearer ${f.token('buyer')}`,'content-type': 'application/json' },body: '{' });
  assert.equal(malformed.status,400);
  const tooLarge=await http(api.url,'getRequirement',{ requirementId,padding: 'x'.repeat(65537) },f.token('buyer')); assert.equal(tooLarge.status,400);
  assert.deepEqual(await f.snapshot(),before);
});

test('MCP strict input rejects forged authority and current revocation invalidates an already connected client',async t => {
  const f=await fixture(t); const { requirementId }=await f.publish('last'); const a=await sdk(f,f.token('producer-a'));
  const before=await f.snapshot();
  let rejected=false;
  try {
    const response=await a.client.callTool({ name: 'purchaseSlot',arguments: { ...purchase('last'),actorId: 'producer-b',funded: true } });
    rejected=response.isError === true;
  } catch { rejected=true; }
  assert.equal(rejected,true); assert.deepEqual(await f.snapshot(),before);
  ok(await a.call('purchaseSlot',purchase('last')));
  await f.pool.query('UPDATE grants SET revoked=true WHERE id=$1',[f.context('producer-a').grantId]); const revoked=await f.snapshot();
  failure(await a.call('purchaseSlot',purchase('last')),'UNAUTHENTICATED');
  const api=await startHttp(f.connectionString,'local_test'); f.cleanupWith(() => api.close());
  const web=await http(api.url,'getRequirement',{ requirementId },f.token('producer-a')); assert.equal(web.status,401);
  const hashes=(await f.pool.query('SELECT token_hash FROM grants')).rows.map(row => row.token_hash as string);
  for (const credential of Object.values(f.credentials)) assert.equal(hashes.includes(credential.token),false);
  assert.deepEqual(await f.snapshot(),revoked); await f.reconcile();
});

test('composition fails closed outside explicit local fixture mode, remote DB targets and missing schema version',async t => {
  const f=await fixture(t); await assert.rejects(() => compose(f.connectionString,'production'),/explicit local_test/);
  assert.throws(() => localPool('postgresql://localhost.invalid/fixture'),/loopback-local/);
  await f.pool.query('DELETE FROM foundation_schema');
  await assert.rejects(() => compose(f.connectionString,'local_test'),/schema readiness/);
});
