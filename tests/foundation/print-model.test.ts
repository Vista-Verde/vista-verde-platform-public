import assert from 'node:assert/strict';
import {test} from 'node:test';
import {advance,defaults,fixtureMesh,inspectStl,MAX_STL_BYTES,minorUnits,quote,syntheticCube} from '../../apps/print-demo/model.ts';
const bytes=(value:string)=>new TextEncoder().encode(value).buffer;
const ascii='solid private-name\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 1\nendloop\nendfacet\nendsolid private-name';
test('STL metadata: synthetic binary cube and strict ASCII bounds; names and bytes are not retained',()=>{
  assert.deepEqual(fixtureMesh(),{format:'binary',triangles:12,bounds:[20,20,20],synthetic:true});
  assert.deepEqual(inspectStl(bytes(ascii)),{format:'ascii',triangles:1,bounds:[1,1,1],synthetic:false});
  assert.equal(JSON.stringify(inspectStl(bytes(ascii))).includes('private-name'),false);
});
test('STL binary solid header is binary; truncation and triangle limits fail closed',()=>{
  const buffer=syntheticCube();new Uint8Array(buffer).set(new TextEncoder().encode('solid private-header'));
  assert.equal(inspectStl(buffer).format,'binary');assert.throws(()=>inspectStl(buffer.slice(0,-1)));
  const empty=new ArrayBuffer(84);assert.throws(()=>inspectStl(empty));
  const tooMany=new ArrayBuffer(84+50*100001);new DataView(tooMany).setUint32(80,100001,true);assert.throws(()=>inspectStl(tooMany),/100,000/);
  new DataView(buffer).setUint32(80,0xffffffff,true);assert.throws(()=>inspectStl(buffer));
});
test('STL rejects nonfinite coordinates, invalid normals, malformed ASCII and oversize files',()=>{
  for(const value of [NaN,Infinity,-Infinity,1e8]){const buffer=syntheticCube();new DataView(buffer).setFloat32(96,value,true);assert.throws(()=>inspectStl(buffer),/coordinates/);}
  const normal=syntheticCube();new DataView(normal).setFloat32(84,Infinity,true);assert.throws(()=>inspectStl(normal),/normal/);
  for(const value of [ascii.replace('vertex 0 1 1','vertex 0 1 NaN'),ascii.replace('vertex 0 1 1','vertex 0 1 1e999'),ascii.replace('endfacet',''),ascii.replace('endsolid','broken'),ascii+'\ntrailing',ascii.replace('vertex 0 1 1','vertex 0 1 1\nvertex 2 2 2')]) assert.throws(()=>inspectStl(bytes(value)));
  assert.throws(()=>inspectStl(new ArrayBuffer(MAX_STL_BYTES+1)),/10 MiB/);
});
test('mock quote requires model, declared units and compatible process/envelope',()=>{
  assert.ok(quote(undefined,defaults).issues.some(value=>value.includes('local STL')));
  assert.ok(quote(fixtureMesh(),defaults).issues.some(value=>value.includes('coordinate unit')));
  for(const material of ['resin','wide'] as const)assert.ok(quote(fixtureMesh(),{...defaults,units:'mm',material}).issues.some(value=>value.includes('PETG')));
  assert.ok(quote(fixtureMesh(),{...defaults,units:'inch'}).issues.some(value=>value.includes('envelope')));
  assert.ok(quote({...fixtureMesh(),bounds:[0,20,20]},{...defaults,units:'mm'}).issues.some(value=>value.includes('envelope')));
});
test('mock costs use exact minor units and included material is never added twice',()=>{
  assert.equal(minorUnits('30.01'),3001);for(const value of ['-1','Infinity','1e2','1.001','9999999',''])assert.equal(minorUnits(value),undefined);
  const offer=quote(fixtureMesh(),{...defaults,units:'mm'});assert.deepEqual(offer.issues,[]);assert.equal(offer.printTotal,3000);assert.equal(offer.materialContribution,400);assert.equal(offer.total,4000);
  const customer=quote(fixtureMesh(),{...defaults,units:'mm',source:'customer',customerAccepted:true});assert.deepEqual(customer.issues,[]);assert.equal(customer.materialContribution,0);assert.equal(customer.total,3600);
});
test('mock customer material acceptance, quantity, deadlines and separate allowances block invalid approval',()=>{
  for(const patch of [{source:'customer' as const},{quantity:'11'},{quantity:'0'},{quantity:'1.5'},{printBudget:'29.99'},{deliveryBudget:'9.99'},{deadlineDays:'5'},{zone:'B' as const},{deadlineDays:'31'}])assert.ok(quote(fixtureMesh(),{...defaults,units:'mm',...patch}).issues.length>0);
  assert.deepEqual(quote(fixtureMesh(),{...defaults,units:'mm',zone:'B',deliveryBudget:'18',deadlineDays:'9'}).issues,[]);
});
test('local simulation cannot skip approval or acknowledge simulated delivery automatically',()=>{
  assert.throws(()=>advance('draft','produce',true));assert.throws(()=>advance('draft','approve_print',false));
  let stage=advance('draft','approve_print',true);assert.throws(()=>advance(stage,'produce',true));stage=advance(stage,'approve_delivery',true);
  stage=advance(stage,'produce',true);stage=advance(stage,'dispatch',true);stage=advance(stage,'deliver',true);assert.equal(stage,'delivered');
  stage=advance(stage,'acknowledge',true);assert.equal(stage,'acknowledged');assert.throws(()=>advance(stage,'acknowledge',true));
});
