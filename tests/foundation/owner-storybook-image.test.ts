import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

test('compiled static image binds reviewed assets, serves them after real RSA verification, and contains no Storybook development dependency',() => {
  const image=process.env.VV_LOCAL_TEST_IMAGE;assert.ok(image,'Set VV_LOCAL_TEST_IMAGE to the freshly built owner Storybook image');
  const artifactDigest=process.env.VV_OWNER_STORYBOOK_TEST_SHA256;assert.match(artifactDigest ?? '',/^[a-f0-9]{64}$/);
  const program=`
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {createRequire} from 'node:module';
import {createLocalJWKSet,exportJWK,generateKeyPair,SignJWT} from 'jose';
import {productionStorybook,storybookArtifactDigest} from './dist/apps/api/src/storybook.js';
import {OWNER_HOST,OWNER_EMAIL,OWNER_ISSUER,startOwnerAccess} from './dist/apps/local/src/owner-access.js';
const expected=process.env.VV_OWNER_STORYBOOK_TEST_SHA256;
const assets=productionStorybook(expected);assert.equal(storybookArtifactDigest(assets),expected);
assert.throws(()=>createRequire(import.meta.url).resolve('storybook'),/MODULE_NOT_FOUND|Cannot find module/);
const pair=await generateKeyPair('RS256'),audience='a'.repeat(64);
const keys=createLocalJWKSet({keys:[{...await exportJWK(pair.publicKey),kid:'compiled-synthetic-fixture',alg:'RS256'}]});
const now=Math.floor(Date.now()/1000);
const token=await new SignJWT({iss:OWNER_ISSUER,aud:[audience],iat:now,exp:now+3600,sub:'compiled-synthetic-fixture',email:OWNER_EMAIL,type:'app'})
 .setProtectedHeader({alg:'RS256',kid:'compiled-synthetic-fixture'}).sign(pair.privateKey);
const gateway=await startOwnerAccess('http://127.0.0.1:4318',{audience},{keys,port:0,host:'127.0.0.1',storybook:{artifactDigest:expected}});
async function call(path,assertion,extra={}){return await new Promise((resolve,reject)=>{
const req=request(gateway.url+path,{headers:{host:OWNER_HOST,...(assertion?{'cf-access-jwt-assertion':assertion}:{}),...extra}},res=>{
let size=0;res.on('data',part=>size+=part.length);res.on('end',()=>resolve({status:res.statusCode,size,policy:res.headers['content-security-policy']}));res.on('error',reject);});req.on('error',reject);req.end();});}
try {
 assert.equal((await call('/')).status,401);assert.equal((await call('/','forged')).status,401);
 const root=await call('/storybook/',token);assert.equal(root.status,200);assert.match(root.policy,/script-src 'self' 'sha256-/);
 assert.doesNotMatch(root.policy,/unsafe-eval|script-src[^;]*unsafe-inline/);
 assert.equal((await call('/storybook/iframe.html',token)).status,200);
 const large=[...assets].find(([,asset])=>asset.body.length>2*1024*1024);assert.ok(large);
 const bundle=await call('/storybook'+large[0],token);assert.equal(bundle.status,200);assert.equal(bundle.size,large[1].body.length);
 assert.equal((await call('/storybook/iframe.html',token,{'sec-fetch-site':'cross-site'})).status,403);
 assert.equal((await call('/app',token)).status,503);
 assert.equal((await call('/',token)).status,503,'App root uses the unavailable app upstream, never the static manager');
 assert.equal((await call('/storybook',token)).status,308);
 console.log(JSON.stringify({compiled:true,artifactDigest:expected,assets:assets.size-1,largeAssetBytes:bundle.size,developmentDependencyAbsent:true}));
} finally {await gateway.close();}
`;
  const result=spawnSync('docker',['run','--rm','-i','--pull=never','--network','none','--read-only','--memory','256m','--cpus','1',
    '--env',`VV_OWNER_STORYBOOK_TEST_SHA256=${artifactDigest}`,'--env','NODE_OPTIONS=--max-old-space-size=192',image,
    'node','--input-type=module'],{ input:program,encoding:'utf8',maxBuffer:1024*1024 });
  assert.equal(result.status,0,result.stderr);const evidence=JSON.parse(result.stdout);
  assert.equal(evidence.compiled,true);assert.equal(evidence.artifactDigest,artifactDigest);assert.equal(evidence.developmentDependencyAbsent,true);
  console.log(JSON.stringify(evidence));
});
