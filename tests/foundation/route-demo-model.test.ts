import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRouteState,reduceRoute,routeQuote,routeScenario} from '../../apps/print-demo/routes-model.ts';
import type {RouteAction,RouteState} from '../../apps/print-demo/routes-model.ts';
const send=(s:RouteState,event:RouteAction,canReview=true)=>reduceRoute(s,{...event,expectedRevision:s.revision},canReview);
test('two declared routes include material once and fit separate output/courier limits',()=>{
 const s=createRouteState(),a=routeQuote(s,'A'),b=routeQuote(s,'B');assert.deepEqual(a.issues,[]);assert.deepEqual(b.issues,[]);
 assert.deepEqual([a.output,a.materialIncluded,a.courier,a.total,a.arrivalDay],[3000,400,1000,4000,6]);assert.deepEqual([b.output,b.materialIncluded,b.courier,b.total,b.arrivalDay],[3600,600,1000,4600,5]);
});
test('scripted delay recomputes stage lead time, proposes viable B and creates no agreement',()=>{
 const s=send(createRouteState(),{type:'delay'});assert.equal(routeQuote(s,'A').arrivalDay,12);assert.equal(s.recommended,'B');assert.equal(s.selected,'A');assert.equal(s.frozen,undefined);assert.match(s.notice,/deterministic rule/);
});
test('advice rejection retains selected A and its infeasibility without allocation',()=>{
 const s=routeScenario('rejected');assert.equal(s.selected,'A');assert.equal(s.recommended,undefined);assert.equal(s.frozen,undefined);assert.ok(routeQuote(s,'A').issues.some(i=>i.includes('misses')));
});
test('a material delay within a relaxed deadline does not falsely require replacement',()=>{
 let s=send(createRouteState(),{type:'edit',changes:{deadline:'30'}});s=send(s,{type:'delay'});
 assert.deepEqual(routeQuote(s,'A').issues,[]);assert.equal(s.recommended,undefined);assert.equal(s.selected,'A');
 s=send(s,{type:'recommend'});assert.equal(s.recommended,undefined);assert.match(s.notice,/still fits/);
 s=send(s,{type:'review',value:true});s=send(s,{type:'approve'});s=send(s,{type:'freeze'});assert.equal(s.frozen?.route,'A');assert.equal(s.frozen?.quote.arrivalDay,12);
});
test('approval requires current permission and an explicit fresh review',()=>{
 let s=routeScenario('delay');s=send(s,{type:'approve'});assert.equal(s.approved,undefined);s=send(s,{type:'review',value:true});s=send(s,{type:'approve'},false);assert.equal(s.approved,undefined);s=send(s,{type:'approve'});assert.equal(s.selected,'B');assert.equal(s.approved?.route,'B');assert.equal(s.frozen,undefined);
});
test('changed budget/quantity invalidates approval and prevents stale freezing',()=>{
 let s=routeScenario('approved');s=send(s,{type:'edit',changes:{quantity:'2'}});assert.equal(s.approved,undefined);assert.equal(s.reviewed,false);s=send(s,{type:'freeze'});assert.equal(s.frozen,undefined);assert.match(s.notice,/blocked/);
});
test('infeasible output budget, delivery allowance, deadline and capacity never produce a forced alternative',()=>{
 for(const changes of [{outputBudget:'30.00'},{courierAllowance:'9.99'},{deadline:'3'},{quantity:'3',outputBudget:'120.00'}]){
  let s=send(createRouteState(),{type:'edit',changes});s=send(s,{type:'delay'});s=send(s,{type:'recommend'});assert.equal(s.recommended,undefined);assert.ok(routeQuote(s,'B').issues.length);s=send(s,{type:'review',value:true});s=send(s,{type:'approve'});assert.equal(s.approved,undefined);
 }
});
test('mesh units, declared process, diameter and color gate compatibility',()=>{
 for(const changes of [{units:'inch' as const},{material:'resin' as const},{diameter:'2.85' as const},{color:'white' as const}]){
  const s=send(createRouteState(),{type:'edit',changes});assert.ok(routeQuote(s,'A').issues.length);assert.ok(routeQuote(s,'B').issues.length);
 }
 const empty=routeScenario('upload');assert.ok(routeQuote(empty,'A').issues.length);
});
test('invalid count and money values cannot be approved',()=>{
 for(const changes of [{quantity:'0'},{quantity:'-1'},{quantity:'1.5'},{quantity:'999999999999999999999'},{outputBudget:'Infinity'},{outputBudget:'10.001'},{deadline:'0'},{deadline:'31'}]){
  let s=send(createRouteState(),{type:'edit',changes});assert.ok(routeQuote(s,'A').issues.length);s=send(s,{type:'review',value:true});s=send(s,{type:'approve'});assert.equal(s.approved,undefined);
 }
});
test('one explicit frozen agreement preserves terms when delayed and blocks replacement',()=>{
 let s=createRouteState();s=send(s,{type:'review',value:true});s=send(s,{type:'approve'});s=send(s,{type:'freeze'});const frozen=structuredClone(s.frozen);assert.ok(frozen);s=send(s,{type:'delay'});assert.deepEqual(s.frozen,frozen);assert.equal(s.recommended,undefined);assert.equal(routeQuote(s,'A').arrivalDay,12);
 for(const action of [{type:'select',route:'B'},{type:'edit',changes:{outputBudget:'999.00'}},{type:'approve'},{type:'freeze'},{type:'request-change'}] as RouteAction[]){s=send(s,action);assert.deepEqual(s.frozen,frozen);assert.equal(s.selected,'A');}
});
test('a delay on unrelated A cannot imply the frozen B agreement failed',()=>{
 let s=send(createRouteState(),{type:'select',route:'B'});s=send(s,{type:'review',value:true});s=send(s,{type:'approve'});s=send(s,{type:'freeze'});s=send(s,{type:'delay'});assert.equal(s.frozen?.route,'B');assert.match(s.notice,/does not affect/);assert.equal(s.events.at(-1)?.kind,'info');
});
test('stale actions and double freezing replay no second agreement or event',()=>{
 const before=routeScenario('approved'),event={type:'freeze' as const,expectedRevision:before.revision},after=reduceRoute(before,event);assert.ok(after.frozen);assert.equal(reduceRoute(after,event),after);
 const delayed=send(createRouteState(),{type:'delay'});assert.equal(reduceRoute(delayed,{type:'approve',expectedRevision:1}),delayed);
});
test('starting a separate run archives frozen terms without cancelling or reusing them',()=>{
 const old=routeScenario('committed'),next=send(old,{type:'reset'});assert.equal(next.run,2);assert.equal(next.frozen,undefined);assert.deepEqual(next.archives,[old.frozen]);assert.equal(next.delayA,false);assert.equal(next.approved,undefined);assert.match(next.notice,/never cancels/);
});
