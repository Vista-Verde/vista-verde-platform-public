import {fixtureMesh,minorUnits,usd} from './model.ts';
import type {Mesh,Units} from './model.ts';

export type RouteId='A'|'B';
export type RouteDraft={units:Units;material:'petg'|'resin';color:'black'|'white';diameter:'1.75'|'2.85';quantity:string;outputBudget:string;courierAllowance:string;deadline:string};
export type RouteQuote={id:RouteId;output:number;materialIncluded:number;courier:number;total:number;readyDay:number;printDays:number;deliveryDays:number;arrivalDay:number;quantity:number;capacity:number;issues:string[]};
export type FrozenPlan={id:string;run:number;route:RouteId;quote:RouteQuote;draft:RouteDraft;mesh:Mesh;termsVersion:number};
export type RouteEvent={id:number;kind:'info'|'decision'|'blocked';text:string};
export type RouteState={run:number;revision:number;termsVersion:number;draft:RouteDraft;mesh?:Mesh;selected:RouteId;delayA:boolean;recommended?:RouteId;reviewed:boolean;approved?:{route:RouteId;termsVersion:number};frozen?:FrozenPlan;archives:FrozenPlan[];events:RouteEvent[];notice:string};
export const routeDefaults:RouteDraft={units:'mm',material:'petg',color:'black',diameter:'1.75',quantity:'1',outputBudget:'40.00',courierAllowance:'10.00',deadline:'7'};
export const routeProviders={
 A:{material:'Mock Grove Materials',printer:'Mock Cedar Workshop',courier:'Mock Local Courier'},
 B:{material:'Mock River Feedstock',printer:'Mock Ridge Studio',courier:'Mock Express Courier'}
};
export function routeQuote(state:RouteState,id:RouteId):RouteQuote{
 const d=state.draft,q=/^[1-9]\d?$/.test(d.quantity)?Number(d.quantity):0,deadline=/^\d{1,2}$/.test(d.deadline)?Number(d.deadline):0;
 const output=(id==='A'?3000:3600)*q,materialIncluded=(id==='A'?400:600)*q,courier=1000,capacity=id==='A'?4:2;
 const readyDay=id==='A'&&state.delayA?7:1,printDays=id==='A'?3:2,deliveryDays=2,arrivalDay=readyDay+printDays+deliveryDays,issues:string[]=[];
 if(!state.mesh)issues.push('Inspect a local STL or use the labeled synthetic cube.');
 if(!d.units)issues.push('Confirm STL coordinate units.');
 const bounds=state.mesh&&d.units?state.mesh.bounds.map(n=>n*(d.units==='inch'?25.4:1)):undefined;
 if(bounds?.some((n,i)=>!Number.isFinite(n)||n<=0||n>[220,220,250][i]!))issues.push('Model bounds exceed the mock 220 × 220 × 250 mm envelope.');
 if(d.material!=='petg'||d.color!=='black'||d.diameter!=='1.75')issues.push('This route declares only FDM / PETG / 1.75 mm / black compatibility.');
 if(!q||q>10)issues.push('Use an integer count of 1–10 parts.');
 if(q>capacity)issues.push('Requested count exceeds this route’s declared mock capacity of '+capacity+' parts.');
 const budget=minorUnits(d.outputBudget),allowance=minorUnits(d.courierAllowance);
 if(budget===undefined||budget<output)issues.push('Output quote exceeds the stated output-work budget.');
 if(allowance===undefined||allowance<courier)issues.push('Separate courier allowance does not cover the mock $10.00 quote.');
 if(deadline<1||deadline>30)issues.push('Choose an arrival deadline of day 1–30.');
 else if(arrivalDay>deadline)issues.push('Arrival day '+arrivalDay+' misses the day '+deadline+' deadline.');
 return{id,output,materialIncluded,courier,total:output+courier,readyDay,printDays,deliveryDays,arrivalDay,quantity:q,capacity,issues};
}
export function createRouteState(fixture=true):RouteState{
 return{run:1,revision:1,termsVersion:1,draft:{...routeDefaults,units:fixture?'mm':''},mesh:fixture?fixtureMesh():undefined,selected:'A',delayA:false,reviewed:false,archives:[],events:[{id:1,kind:'info',text:'Run 1 opened: two fictional production paths; every price, capacity and stage is simulated.'}],notice:''};
}
type Changes=Partial<RouteDraft>;
export type RouteAction=
 |{type:'edit';changes:Changes}
 |{type:'mesh';mesh?:Mesh;units:Units}
 |{type:'select';route:RouteId}
 |{type:'delay'}
 |{type:'recommend'}
 |{type:'review';value:boolean}
 |{type:'approve'}
 |{type:'reject'}
 |{type:'freeze'}
 |{type:'request-change'}
 |{type:'reset'};
export type RouteEnvelope=RouteAction&{expectedRevision:number};
function recorded(state:RouteState,text:string,kind:RouteEvent['kind']='info'):RouteState{
 return{...state,revision:state.revision+1,notice:text,events:[...state.events,{id:state.events.length+1,kind,text}]};
}
function invalidate(state:RouteState):RouteState{
 return{...state,termsVersion:state.termsVersion+1,reviewed:false,approved:undefined,recommended:undefined};
}
function shouldRecommendB(state:RouteState):boolean{
 return state.delayA&&state.selected==='A'&&routeQuote(state,'A').issues.length>0&&routeQuote(state,'B').issues.length===0;
}
export function reduceRoute(state:RouteState,event:RouteEnvelope,canReview=true):RouteState{
 if(event.expectedRevision!==state.revision)return state;
 if(event.type==='reset'){
  const next=createRouteState(true),archives=state.frozen?[...state.archives,state.frozen]:state.archives;
  return{...next,run:state.run+1,revision:state.revision+1,archives,events:[{id:1,kind:'info',text:'Run '+(state.run+1)+' opened as a separate simulation. Prior frozen agreements remain archived; no shared agreement was cancelled.'}],notice:'New sandbox run opened. This never cancels or releases a persisted commitment.'};
 }
 if(event.type==='delay'){
  if(state.delayA)return state;
  const delayed={...state,delayA:true};
  if(state.frozen)return recorded({...delayed,recommended:undefined,reviewed:false},state.frozen.route==='A'?'Material delay recorded. Frozen '+state.frozen.id+' is unchanged. Replacement is blocked until a separately approved disposition policy.':'A’s material delay does not affect the frozen B agreement. Its terms remain unchanged.',state.frozen.route==='A'?'blocked':'info');
  const next=invalidate(delayed),recommend=shouldRecommendB(next);
  return recorded({...next,recommended:recommend?'B':undefined},'Scripted report at day 0: A’s material is now ready day 7; projected arrival moves from day 6 to day 12. '+(recommend?'The deterministic rule proposes B. Human review is required because price, providers and timing change.':'No replacement is automatically selected.'),'decision');
 }
 if(state.frozen)return recorded(state,'Change blocked: '+state.frozen.id+' remains frozen. Its quantity and output budget are still consumed in this run. No replacement, refund or release is modeled.','blocked');
 switch(event.type){
  case 'edit':{
   const labels:Record<keyof RouteDraft,string>={units:'Units',material:'Material',color:'Color',diameter:'Filament diameter',quantity:'Count',outputBudget:'Output budget',courierAllowance:'Courier allowance',deadline:'Deadline'};
   const changed=(Object.keys(event.changes) as (keyof RouteDraft)[]).filter(key=>event.changes[key]!==state.draft[key]);
   if(!changed.length)return state;
   return recorded(invalidate({...state,draft:{...state.draft,...event.changes}}),'Requirements changed: '+changed.map(key=>labels[key]+': '+(state.draft[key]||'unconfirmed')+' → '+(event.changes[key]||'unconfirmed')).join('; ')+'. Earlier review and plan approval are invalid.');
  }
  case 'mesh':return recorded(invalidate({...state,mesh:event.mesh,draft:{...state.draft,units:event.units}}),event.mesh?'Local mesh metadata changed; review its units and the new terms.':'Model cleared. Approval remains blocked until valid metadata is supplied.');
  case 'select':if(event.route===state.selected)return state;return recorded(invalidate({...state,selected:event.route}),'Route '+event.route+' selected for nonbinding review. No supply, money or production is reserved.');
  case 'recommend':{
   const recommend=shouldRecommendB(state),fits=routeQuote(state,state.selected).issues.length===0;
   return recorded({...state,reviewed:false,approved:undefined,recommended:recommend?'B':undefined},recommend?'Deterministic rule proposes B: it meets the current declared limits. Review the cost and timing difference.':fits?'The selected route still fits the declared requirements. No change is required by this rule.':'The script found no eligible alternative to the current plan. Inspect the route blockers.','decision');
  }
  case 'review':if(!canReview)return recorded(state,'Review blocked: this participant lacks confirmation permission.','blocked');return{...state,revision:state.revision+1,reviewed:event.value};
  case 'reject':if(!state.recommended)return state;if(!canReview)return recorded(state,'Rejection blocked: this participant lacks confirmation permission.','blocked');return recorded({...state,recommended:undefined,reviewed:false,approved:undefined},'Human rejected the scripted suggestion. Route '+state.selected+' stays selected and must meet the requirements before any agreement can be frozen.','decision');
  case 'approve':{
   const id=state.recommended??state.selected,quote=routeQuote(state,id);
   if(!canReview||!state.reviewed||quote.issues.length)return recorded(state,'Approval blocked: current participant permission, fresh review and feasible terms are required.','blocked');
   const changed=id!==state.selected,next=changed?invalidate({...state,selected:id}):state;
   return recorded({...next,recommended:undefined,reviewed:false,approved:{route:id,termsVersion:next.termsVersion}},'Human approved route '+id+' in this local simulation. This is advice approval, not shared buyer/producer consent or a real order.','decision');
  }
  case 'freeze':{
   const q=routeQuote(state,state.selected);
   if(!canReview||!state.approved||state.approved.termsVersion!==state.termsVersion||state.approved.route!==state.selected||q.issues.length||!state.mesh)return recorded(state,'Agreement blocked: approve fresh feasible terms first.','blocked');
   const frozen:FrozenPlan={id:'SIM-RUN-'+state.run+'-AGREEMENT-'+state.selected,run:state.run,route:state.selected,quote:structuredClone(q),draft:{...state.draft},mesh:structuredClone(state.mesh),termsVersion:state.termsVersion};
   return recorded({...state,frozen},frozen.id+' frozen by an explicit demo checkpoint: '+q.quantity+' each and '+usd(q.output)+' of output budget consumed in this run. No shared command was sent.','decision');
  }
  case 'request-change':return recorded(state,'No frozen agreement exists. Keep comparing nonbinding candidates.','info');
 }
}
export function routeScenario(name:'ready'|'upload'|'delay'|'approved'|'rejected'|'infeasible'|'committed'|'changed'):RouteState{
 let state=createRouteState(name!=='upload');
 const send=(action:RouteAction)=>{state=reduceRoute(state,{...action,expectedRevision:state.revision});};
 if(name==='infeasible')send({type:'edit',changes:{outputBudget:'30.00'}});
 if(['delay','approved','rejected','infeasible'].includes(name))send({type:'delay'});
 if(name==='rejected')send({type:'reject'});
 if(name==='approved'){send({type:'review',value:true});send({type:'approve'});}
 if(name==='committed'){send({type:'review',value:true});send({type:'approve'});send({type:'freeze'});send({type:'delay'});}
 if(name==='changed'){send({type:'review',value:true});send({type:'approve'});send({type:'edit',changes:{quantity:'2'}});}
 return state;
}
