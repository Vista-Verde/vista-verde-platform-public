import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import type { OutgoingHttpHeaders } from 'node:http';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { productionStorybook, storybookArtifactDigest, storybookRoute } from '../../apps/api/src/storybook.ts';
import { OWNER_HOST, OWNER_EMAIL, OWNER_ORIGIN, OWNER_ISSUER, ownerStorybookConfiguration,
  startOwnerAccess } from '../../apps/local/src/owner-access.ts';

const assets=productionStorybook();
const artifactDigest=storybookArtifactDigest(assets);
const audience='a'.repeat(64);
const pair=await generateKeyPair('RS256');
const keys=createLocalJWKSet({ keys:[{ ...await exportJWK(pair.publicKey),kid:'storybook-fixture',alg:'RS256' }] });
async function signed(changes:Record<string,unknown>={}) {
  const now=Math.floor(Date.now()/1000);
  return await new SignJWT({ iss:OWNER_ISSUER,aud:[audience],iat:now,exp:now+3600,
    sub:'storybook-owner-fixture',email:OWNER_EMAIL,type:'app',...changes })
    .setProtectedHeader({ alg:'RS256',kid:'storybook-fixture' }).sign(pair.privateKey);
}
async function call(url:string,path:string,method='GET',headers:OutgoingHttpHeaders={}) {
  const target=new URL(url);
  return await new Promise<{ status:number;headers:OutgoingHttpHeaders;body:Buffer }>((resolve,reject) => {
    const req=request({ hostname:target.hostname,port:target.port,path,method,headers:{ host:OWNER_HOST,...headers } },res => {
      const parts:Buffer[]=[];res.on('data',(part:Buffer) => parts.push(part));res.on('error',reject);
      res.on('end',() => resolve({ status:res.statusCode!,headers:res.headers,body:Buffer.concat(parts) }));
    });req.on('error',reject);req.end();
  });
}
async function setup(t:TestContext) {
  const seen:{ path:string;headers:OutgoingHttpHeaders }[]=[];
  const upstream=createServer((req,res) => { seen.push({ path:req.url!,headers:req.headers });
    res.setHeader('content-type',req.url === '/app.js' ? 'text/javascript':'text/html');res.end('synthetic working app'); });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');const address=upstream.address();
  assert.ok(address && typeof address !== 'string');
  const gateway=await startOwnerAccess(`http://127.0.0.1:${address.port}`,{ audience },
    { keys,port:0,host:'127.0.0.1',storybook:{ artifactDigest } });
  t.after(() => gateway.close());t.after(() => new Promise<void>(resolve => upstream.close(() => resolve())));
  return { gateway,seen,headers:{ 'cf-access-jwt-assertion':await signed() } };
}

test('static owner Storybook is opt-in and binds the exact reviewed production artifact',async () => {
  assert.equal(ownerStorybookConfiguration({}),undefined);
  assert.equal(ownerStorybookConfiguration({ VV_OWNER_STORYBOOK:'false' }),undefined);
  const env={ VV_OWNER_ACCESS_ENABLED:'true',VV_OWNER_STORYBOOK:'true',VV_OWNER_STORYBOOK_SHA256:artifactDigest };
  assert.deepEqual(ownerStorybookConfiguration(env),{ artifactDigest });
  for (const changes of [{ VV_OWNER_ACCESS_ENABLED:'false' },{ VV_OWNER_STORYBOOK:'yes' },
    { VV_OWNER_STORYBOOK_SHA256:'' },{ VV_OWNER_STORYBOOK_SHA256:'0'.repeat(64) },{ VV_OWNER_STORYBOOK_SHA256:'not-a-digest' }])
    assert.throws(() => ownerStorybookConfiguration({ ...env,...changes }));
  assert.equal(storybookArtifactDigest(productionStorybook(artifactDigest)),artifactDigest);
  assert.throws(() => productionStorybook('f'.repeat(64)),/reviewed digest/);
  await assert.rejects(() => startOwnerAccess('http://127.0.0.1:4318',{ audience },
    { keys,port:0,host:'127.0.0.1',storybook:{ artifactDigest:'f'.repeat(64) } }),/reviewed digest/);
});

test('full RSA owner authentication precedes manager, iframe, index and large compiled asset responses',async t => {
  const { gateway,headers,seen }=await setup(t);
  const large=[...assets].find(([,asset]) => asset.body.length>2*1024*1024);
  assert.ok(large,'Real production Storybook contains a bundle beyond the old upstream response cap');
  const paths=['/storybook/','/storybook/iframe.html','/storybook/index.json','/storybook'+large[0]];
  for (const path of paths) {
    for (const assertion of [undefined,'forged',await signed({ email:'other@fixture.invalid' }),
      await signed({ exp:Math.floor(Date.now()/1000)-1 }),await signed({ aud:['b'.repeat(64)] })]) {
      const denied=await call(gateway.url,path,'GET',assertion ? { 'cf-access-jwt-assertion':assertion }:{});
      assert.equal(denied.status,401);assert.doesNotMatch(denied.body.toString(),/storybook|fixture|subject|personas/i);
    }
    const result=await call(gateway.url,path,'GET',headers);assert.equal(result.status,200);
    assert.deepEqual(result.body,assets.get(path.slice(10))!.body);assert.equal(result.headers['set-cookie'],undefined);
    assert.equal(result.headers['cache-control'],'no-store');assert.equal(result.headers['cross-origin-resource-policy'],'same-origin');
    const policy=String(result.headers['content-security-policy']);
    assert.doesNotMatch(policy,/unsafe-eval|script-src[^;]*unsafe-inline/);
    assert.match(policy,/frame-src 'self'/);assert.match(policy,/frame-ancestors 'self'/);
    if (path === '/storybook/' || path === '/storybook/iframe.html') assert.match(policy,/script-src 'self' 'sha256-/);
    const head=await call(gateway.url,path,'HEAD',headers);assert.equal(head.status,200);assert.equal(head.body.length,0);
    assert.equal(Number(head.headers['content-length']),assets.get(path.slice(10))!.body.length);
  }
  assert.equal(seen.length,0,'Static artifact never enters backend proxy or database');
});

test('only exact app/Storybook entry documents cross sites; preview, assets, aliases and API stay protected',async t => {
  const { gateway,headers,seen }=await setup(t);
  const navigation={ 'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document' };
  for (const path of ['/','/storybook/'])for (const method of ['GET','HEAD'])assert.equal((await call(gateway.url,path,method,{ ...headers,...navigation })).status,200);
  for (const path of ['/iframe.html','/storybook/iframe.html','/iframe.html?id=work-orders-work-order-board--representative','/index.json','/storybook/index.json','/storybook/?path=/story/work-orders-work-order-board--representative','/app','/app.js',
    '/session','/queries/getWorkspace','/commands/createRequirementDraft','/?persona=buyer','/?path=/story/work-orders-work-order-board--representative'])
    assert.equal((await call(gateway.url,path,'GET',{ ...headers,...navigation })).status,403,path);
  for (const changes of [{ 'sec-fetch-mode':'cors' },{ 'sec-fetch-dest':'iframe' },{ 'sec-fetch-site':'same-site' },
    { origin:'https://hostile.fixture.invalid' },{ host:'hostile.fixture.invalid' },{ authorization:'Bearer synthetic' }])
    assert.equal((await call(gateway.url,'/','GET',{ ...headers,...navigation,...changes })).status,403);
  for (const path of ['/iframe.html','/index.json'])
    assert.equal((await call(gateway.url,path,'GET',{ ...headers,'sec-fetch-site':'cross-site','sec-fetch-mode':'no-cors','sec-fetch-dest':'script' })).status,403);
  for (const path of ['/../package.json','/%2e%2e/package.json','/.env','/storybook-static/index.html','/index.html.map',
    '/iframe.html/../../index.html','//index.html','/storybook/../session','/storybook/%2e%2e/package.json','/storybook//iframe.html','/storybook/commands/postWorkOrder']) assert.equal((await call(gateway.url,path,'GET',headers)).status,403,path);
  const legacy=await call(gateway.url,'/iframe.html?id=work-orders-work-order-board--representative&viewMode=story','GET',headers);assert.equal(legacy.status,308);assert.equal(legacy.headers.location,'/storybook/iframe.html?id=work-orders-work-order-board--representative&viewMode=story');
  assert.equal((await call(gateway.url,String(legacy.headers.location),'GET',headers)).status,200);
  assert.equal((await call(gateway.url,'/','POST',{ ...headers,origin:OWNER_ORIGIN,'sec-fetch-site':'same-origin' })).status,403);
  assert.deepEqual(seen.map(value=>value.path),['/','/']);
});

test('working app is at root with /app aliases and retains its independent CSP and header allowlist',async t => {
  const { gateway,headers,seen }=await setup(t);
  for (const path of ['/','/app','/app/','/app.js','/style.css']) {
    const result=await call(gateway.url,path,'GET',{ ...headers,'cf-access-authenticated-user-email':OWNER_EMAIL,
      'x-forwarded-host':'hostile.fixture.invalid',cookie:'vv_demo_session=foreign; CF_Authorization=synthetic' });
    assert.equal(result.status,200);assert.match(String(result.headers['content-security-policy']),/frame-ancestors 'none'/);
    assert.doesNotMatch(String(result.headers['content-security-policy']),/unsafe-inline|unsafe-eval/);
  }
  assert.deepEqual(seen.map(value => value.path),['/','/','/','/app.js','/style.css']);
  for (const value of seen) for (const name of ['cf-access-jwt-assertion','cf-access-authenticated-user-email','x-forwarded-host','cookie'])
    assert.equal(value.headers[name],undefined);
  assert.equal((await call(gateway.url,'/app?storybook=true','GET',headers)).status,403);
});

test('fixed Storybook mount keeps legacy deep links same-origin and never interprets API or traversal paths',()=>{
 const q='?path=/story/print-coordinated-route-demo--recommendation-pending&globals=viewport:mobile1';
 assert.equal(storybookRoute('/storybook'+q,assets).redirect,'/storybook/'+q);
 assert.equal(storybookRoute('/'+q,assets).redirect,'/storybook/'+q);
 assert.equal(storybookRoute('/storybook/',assets).asset,assets.get('/'));
 assert.equal(storybookRoute('/storybook/index.json',assets).asset,assets.get('/index.json'));
 assert.equal(storybookRoute('/iframe.html?id=print-coordinated-route-demo--recommendation-pending',assets).redirect,'/storybook/iframe.html?id=print-coordinated-route-demo--recommendation-pending');
 for(const path of ['/session','/commands/postWorkOrder','/app','/app.js','/?persona=buyer','/?path=https://hostile.invalid','/?path=/story/a&path=/story/b','/storybook/../session','/storybook/%2e%2e/package.json','/storybook//iframe.html','//storybook/iframe.html','/storybook/unknown.js'])assert.deepEqual(storybookRoute(path,assets),{},path);
});

test('canonical and legacy Storybook redirects require full owner authentication and never create sessions',async t=>{
 const {gateway,headers,seen}=await setup(t);
 for(const [path,target] of [['/storybook','/storybook/'],['/?path=/story/print-coordinated-route-demo--recommendation-pending','/storybook/?path=/story/print-coordinated-route-demo--recommendation-pending'],['/index.json','/storybook/index.json']]){
  for(const value of [undefined,'forged',await signed({email:'wrong@fixture.invalid'})])assert.equal((await call(gateway.url,path!,'GET',value?{'cf-access-jwt-assertion':value}:{})).status,401);
  for(const method of ['GET','HEAD']){const result=await call(gateway.url,path!,method,headers);assert.equal(result.status,308);assert.equal(result.headers.location,target);assert.equal(result.headers['set-cookie'],undefined);assert.equal(result.body.length,0);}
 }
 assert.equal(seen.length,0);
});
