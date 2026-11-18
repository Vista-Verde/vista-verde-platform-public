import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { BASELINE,envelope,operations } from '../../packages/contracts/src/index.ts';
import type { Operation } from '../../packages/contracts/src/index.ts';
import { fixture,ok,failure } from './helpers.ts';
import { browserSession,web } from './web-helpers.ts';
import { execute,orderInput,proposalInput,confirmationInput,reportInput,acknowledgementInput,recordId,
  getOrder,getProposal,getCommitment,getWorkspace,financialSnapshot,noFinancialEffects,noMutation,
  reconcileMarket } from './market-helpers.ts';
import type { MarketFixture,Caller } from './market-helpers.ts';

async function sdk(f: MarketFixture,actor: string) {
  const credential=f.token(actor);
  const client=new Client({name:'goods-market-proof',version:BASELINE},{versionNegotiation:{mode:{pin:'2026-07-28'}}});
  const transport=new StdioClientTransport({command:process.execPath,args:['dist/apps/api/src/stdio.js'],
    env:{VV_DATABASE_URL:f.connectionString,VV_FIXTURE_MODE:'local_test',VV_FIXTURE_CREDENTIAL:credential},stderr:'pipe'});
  let diagnostics=''; transport.stderr?.on('data',bytes=>{diagnostics+=String(bytes);});
  f.cleanupWith(async()=>{await client.close();assert.equal(diagnostics.includes(credential),false,'A fixture credential never appears in adapter diagnostics');});
  await client.connect(transport,{timeout:5000});
  assert.equal(client.getNegotiatedProtocolVersion(),'2026-07-28');
  const listed=(await client.listTools()).tools;
  assert.deepEqual(listed.map(tool=>tool.name).sort(),Object.keys(operations).sort());
  for (const tool of listed) {assert.equal(tool.inputSchema.additionalProperties,false);assert.ok(tool.outputSchema);}
  const call: Caller=async(operation,input)=>{
    const reply=await client.callTool({name:operation,arguments:input as Record<string,unknown>});
    const receipt=envelope.parse(reply.structuredContent); assert.equal(reply.isError,!receipt.ok); return receipt;
  };
  return {client,call};
}

async function bearerRead(url: string,operation: Operation,input: unknown,credential?: string,extra: Record<string,string>={}) {
  const body=JSON.stringify(input);
  // node:http sends an explicit Host override on the wire. Undici's fetch can
  // replace it with the URL authority, which would not exercise rebinding defense.
  return await new Promise<{status:number;cacheControl:string|undefined;receipt:ReturnType<typeof envelope.parse>}>((resolve,reject)=>{
    const req=request(`${url}/queries/${operation}`,{method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),
      ...(credential ? {authorization:`Bearer ${credential}`} : {}),...extra}},response=>{
      let text='';response.on('data',bytes=>{text+=String(bytes);});response.on('error',reject);
      response.on('end',()=>{try {resolve({status:response.statusCode!,cacheControl:response.headers['cache-control'],receipt:envelope.parse(JSON.parse(text))});}catch(error){reject(error);}});
    });
    req.on('error',reject);req.end(body);
  });
}

test('market adapters: real MCP SDK and authenticated HTTP share posting, explicit approvals, 8+4 commitments and 5/3/4 fulfillment IDs',async t => {
  const f=await fixture(t),api=await web(f),finances=await financialSnapshot(f);
  const agent=await sdk(f,'buyer-agent'),buyer=await sdk(f,'buyer'),sellerA=await sdk(f,'producer-a'),sellerB=await sdk(f,'producer-b');
  const buyerWeb=await browserSession(api.url,'buyer'),aWeb=await browserSession(api.url,'producer-a'),bWeb=await browserSession(api.url,'producer-b');
  const webBuyer: Caller=async(operation,input)=>(await buyerWeb.call(operation,input)).receipt;
  const posted=ok(await agent.call('createMarketOrder',orderInput('sdk-buy','buy',2))),orderId=recordId(posted,'orderId');
  const browserPosted=ok((await aWeb.call('createMarketOrder',orderInput('web-sell','sell',2,{supplyMode:'made_to_order'}))).receipt);
  assert.equal((await getOrder(webBuyer,orderId)).side,'buy');
  assert.equal((await getOrder(sellerA.call,recordId(browserPosted,'orderId'))).supplyMode,'made_to_order');
  const proposalA=recordId(ok(await agent.call('proposeMarketAllocation',proposalInput('sdk-eight'))),'proposalId');
  const proposed=await getProposal(buyer.call,proposalA); assert.equal(proposed.buyerApproved,false); assert.equal(proposed.sellerApproved,false);
  failure(await agent.call('confirmMarketProposal',confirmationInput('agent-confirm-denied',proposalA,1)),'FORBIDDEN');
  ok((await buyerWeb.call('confirmMarketProposal',confirmationInput('web-buyer-eight',proposalA,1))).receipt);
  assert.equal((await getOrder(sellerA.call,'panel-sell-a')).allocatedQuantity.value,0);
  const finalA=ok(await sellerA.call('confirmMarketProposal',confirmationInput('sdk-seller-eight',proposalA,2)));
  const commitmentA=recordId(finalA,'commitmentId');
  const proposalB=recordId(ok(await sellerB.call('proposeMarketAllocation',proposalInput('sdk-four','panel-buy','panel-sell-b',4,
    {expectedBuyVersion:2,unitPrice:{minorUnits:9500,currency:'USD'}}))),'proposalId');
  ok(await buyer.call('confirmMarketProposal',confirmationInput('sdk-buyer-four',proposalB,1)));
  const commitmentB=recordId(ok((await bWeb.call('confirmMarketProposal',confirmationInput('web-seller-four',proposalB,2))).receipt),'commitmentId');
  const reportA5=ok(await sellerA.call('reportMarketFulfillment',reportInput('sdk-five',commitmentA,1,5)));
  ok((await buyerWeb.call('acknowledgeMarketFulfillment',acknowledgementInput('web-five',recordId(reportA5,'fulfillmentId')))).receipt);
  const reportA3=ok((await aWeb.call('reportMarketFulfillment',reportInput('web-three',commitmentA,3,3))).receipt);
  ok(await buyer.call('acknowledgeMarketFulfillment',acknowledgementInput('sdk-three',recordId(reportA3,'fulfillmentId'))));
  const reportB4=ok(await sellerB.call('reportMarketFulfillment',reportInput('sdk-four-report',commitmentB,1,4)));
  ok((await buyerWeb.call('acknowledgeMarketFulfillment',acknowledgementInput('web-four-ack',recordId(reportB4,'fulfillmentId')))).receipt);
  for (const [operation,input] of [
    ['listMarketItems',{search:'panel'}],['getMarketItem',{itemId:'PANEL-DEMO'}],['getMarketWorkspace',{}],
    ['getMarketOrder',{orderId:'panel-buy'}],['getMarketProposal',{proposalId:proposalA}],
    ['getMarketCommitment',{commitmentId:commitmentA}],['getHouseProject',{projectId:'house-demo'}],
    ['getMarketAudit',{recordId:proposalA,limit:100}]
  ] as [Operation,unknown][]) {
    const mcp=await buyer.call(operation,input),browser=await buyerWeb.call(operation,input),http=await bearerRead(api.url,operation,input,f.token('buyer'));
    assert.equal(browser.status,200); assert.equal(http.status,200); assert.equal(http.cacheControl,'no-store');
    assert.deepEqual(browser.receipt,mcp); assert.deepEqual(http.receipt,mcp);
  }
  for (const id of [commitmentA,commitmentB]) assert.equal((await getCommitment(buyer.call,id)).state,'completed');
  const newSession=await browserSession(api.url,'buyer');
  assert.deepEqual((await newSession.call('getMarketCommitment',{commitmentId:commitmentA})).receipt,await buyer.call('getMarketCommitment',{commitmentId:commitmentA}));
  assert.equal((await getOrder(webBuyer,'panel-buy')).remainingQuantity.value,0);
  assert.equal((await getOrder(webBuyer,'panel-buy')).acknowledgedQuantity.value,12);
  await noFinancialEffects(f,finances); await reconcileMarket(f);
});

test('market adapters: forged identity, untrusted funding, wrong units, hostile browser origins and bearer writes fail closed',async t => {
  const f=await fixture(t),api=await web(f),buyer=await browserSession(api.url,'buyer'),agent=await sdk(f,'buyer-agent');
  const input=orderInput('boundary-order','buy',1);
  for (const extra of [{actorId:'operator'},{organizationId:'producer-a-org'},{funded:true},{quantity:{value:1,unit:'kg'}}]) {
    await noMutation(f,async()=>failure((await buyer.call('createMarketOrder',{...input,...extra})).receipt,'VALIDATION_FAILED'));
    await noMutation(f,async()=>{
      let rejected=false;
      try {const reply=await agent.client.callTool({name:'createMarketOrder',arguments:{...input,...extra}});rejected=reply.isError===true;} catch {rejected=true;}
      assert.equal(rejected,true,'The actual SDK tool validates the same strict contract');
    });
  }
  for (const headers of [{origin:'https://hostile.invalid'},{origin:''},{'x-csrf-token':''},{'x-csrf-token':'forged'},
    {'sec-fetch-site':'cross-site'},{host:'hostile.invalid'}] as Record<string,string>[]) {
    await noMutation(f,async()=>{const denied=await buyer.call('createMarketOrder',input,headers);assert.equal(denied.status,403);failure(denied.receipt,'FORBIDDEN');});
  }
  await noMutation(f,async()=>{
    const response=await fetch(`${api.url}/commands/createMarketOrder`,{method:'POST',headers:{authorization:`Bearer ${f.token('buyer')}`,'content-type':'application/json'},body:JSON.stringify(input)});
    assert.equal(response.status,403);
  });
  for (const [credential,headers,status] of [[undefined,{},401],['x'.repeat(43),{},401],
    [f.token('buyer'),{origin:'https://hostile.invalid'},403],[f.token('buyer'),{host:'hostile.invalid'},403]] as [string|undefined,Record<string,string>,number][]) {
    await noMutation(f,async()=>{const result=await bearerRead(api.url,'getMarketOrder',{orderId:'panel-buy'},credential,headers);assert.equal(result.status,status);assert.equal(result.receipt.ok,false);});
  }
  const malformed=await fetch(`${api.url}/commands/createMarketOrder`,{method:'POST',headers:buyer.headers,body:'{'});assert.equal(malformed.status,400);
  const tooLarge=await buyer.call('createMarketOrder',{padding:'x'.repeat(65537)});assert.equal(tooLarge.status,400); await reconcileMarket(f);
});

test('market adapters: connected credentials recheck revocation, expiration and object scope before replay or private readback',async t => {
  const f=await fixture(t),api=await web(f),client=await sdk(f,'buyer'),session=await browserSession(api.url,'buyer');
  const input=proposalInput('adapter-private'),proposalId=recordId(ok(await client.call('proposeMarketAllocation',input)),'proposalId');
  await f.pool.query('UPDATE grants SET market_scopes=ARRAY[]::text[] WHERE id=$1',[f.context('buyer').grantId]);
  await noMutation(f,async()=>{
    failure(await client.call('proposeMarketAllocation',input),'FORBIDDEN');
    const response=await session.call('getMarketProposal',{proposalId}); assert.equal(response.status,403); failure(response.receipt,'FORBIDDEN');
  });
  await f.pool.query("UPDATE grants SET market_scopes=ARRAY['*'],revoked=true WHERE id=$1",[f.context('buyer').grantId]);
  await noMutation(f,async()=>{
    failure(await client.call('proposeMarketAllocation',input),'UNAUTHENTICATED');
    const response=await session.call('confirmMarketProposal',confirmationInput('revoked-consent',proposalId,1));assert.equal(response.status,401);failure(response.receipt,'UNAUTHENTICATED');
  });
  await f.pool.query("UPDATE grants SET revoked=false,expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.context('buyer').grantId]);
  await noMutation(f,async()=>failure(await client.call('getMarketProposal',{proposalId}),'UNAUTHENTICATED'));
  const foreign=await sdk(f,'other-buyer');
  await noMutation(f,async()=>failure(await foreign.call('getMarketProposal',{proposalId}),'FORBIDDEN'));
  assert.equal((await getWorkspace(foreign.call)).proposals.some(p=>p.proposalId===proposalId),false);
  const credentialHashes=(await f.pool.query('SELECT token_hash FROM grants')).rows.map(row=>row.token_hash);
  for (const credential of Object.values(f.credentials)) assert.equal(credentialHashes.includes(credential.token),false);
  await reconcileMarket(f);
});

test('market adapters: HTTP and MCP simultaneous final demand confirmations share one atomic remaining quantity',async t => {
  const f=await fixture(t),api=await web(f),buyer=execute(f,'buyer');
  const demand=recordId(ok(await buyer('createMarketOrder',orderInput('adapter-last-buy','buy',1))),'orderId');
  const a=recordId(ok(await execute(f,'producer-a')('createMarketOrder',orderInput('adapter-last-a','sell',1))),'orderId');
  const b=recordId(ok(await execute(f,'producer-b')('createMarketOrder',orderInput('adapter-last-b','sell',1))),'orderId');
  const pA=recordId(ok(await buyer('proposeMarketAllocation',proposalInput('adapter-last-pA',demand,a,1))),'proposalId');
  const pB=recordId(ok(await buyer('proposeMarketAllocation',proposalInput('adapter-last-pB',demand,b,1))),'proposalId');
  ok(await buyer('confirmMarketProposal',confirmationInput('adapter-approve-a',pA,1)));ok(await buyer('confirmMarketProposal',confirmationInput('adapter-approve-b',pB,1)));
  const http=await browserSession(api.url,'producer-a'),mcp=await sdk(f,'producer-b');
  const inputA=confirmationInput('adapter-final-a',pA,2),inputB=confirmationInput('adapter-final-b',pB,2);
  const replies=await Promise.all([http.call('confirmMarketProposal',inputA).then(reply=>reply.receipt),mcp.call('confirmMarketProposal',inputB)]);
  assert.equal(replies.filter(reply=>reply.ok).length,1);failure(replies.find(reply=>!reply.ok)!,'ORDER_UNAVAILABLE');
  const winner=replies[0]!.ok ? 0 : 1; const call: Caller=winner===0 ? async(operation,input)=>(await http.call(operation,input)).receipt : mcp.call;
  await noMutation(f,async()=>assert.deepEqual(await call('confirmMarketProposal',winner===0 ? inputA : inputB),replies[winner]));
  assert.equal((await getOrder(buyer,demand)).allocatedQuantity.value,1); await reconcileMarket(f);
});
