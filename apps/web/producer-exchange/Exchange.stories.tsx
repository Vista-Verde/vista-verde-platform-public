import type {Meta,StoryObj} from '@storybook/react-vite';
import {expect,fn,within,userEvent} from 'storybook/test';
import {ExchangeView} from './ExchangeView.tsx';
import {PRODUCER_VERSION} from '../../producer-demo/protocol.ts';
import type {ExchangeView as View} from '../../producer-demo/protocol.ts';
import './style.css';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const at='2026-10-17T12:00:00Z';
const quoted:View={schemaVersion:PRODUCER_VERSION,ok:true,runId:id(1),observedAt:at,requester:'deterministic',producer:'simulated',recent:[],exchange:{requestId:id(2),runId:id(1),revision:1,submitCommandId:id(3),createdAt:at,
  brief:{need:'Desk organizer bracket',material:'PLA requested, compatibility unverified',quantity:1,budgetMinor:3000,stl:'not_provided',scenario:'normal'},
  quote:{quoteId:id(4),revision:1,priceMinor:2500,currency:'USD',leadHours:48,leadStarts:'producer_acceptance',expiresAt:'2026-10-17T12:05:00Z',termsDigest:'a'.repeat(64),blockers:[],assumptions:['Conditional synthetic quote. No STL supplied; printability unverified.','USD5 setup plus USD20 per part. Material included once. No shipping or payment.']},job:null,
  messages:[{messageId:id(5),correlationId:id(3),replyTo:null,sequence:1,sender:'requester',kind:'SubmitPartRequest',at,summary:'Synthetic fixture request: one desk organizer bracket.'},{messageId:id(6),correlationId:id(3),replyTo:id(3),sequence:2,sender:'producer',kind:'QuoteReady',at,summary:'Synthetic fixture quote: USD25, 48 hours after acceptance.'}]}};
function state(value:'queued'|'completed_simulated'|'failed_simulated'):View{const view=structuredClone(quoted);view.exchange!.job={jobId:id(7),quoteId:id(4),acceptedAt:at,producerAcceptedAt:at,state:value,sequence:value==='queued'?1:3};return view;}
const meta={title:'Print/Producer exchange',component:ExchangeView,decorators:[Story=><div className="producer-exchange"><h1>Producer exchange component fixture</h1><p>Static Storybook fixture. Live HTTP behavior is verified separately in executable service/browser tests.</p><Story/></div>],args:{view:quoted,canApprove:true,onApprove:fn(),onSelect:fn()}} satisfies Meta<typeof ExchangeView>;
export default meta;type Story=StoryObj<typeof meta>;
export const ConditionalQuote:Story={play:async({canvasElement,args})=>{const canvas=within(canvasElement);await expect(canvas.getByText('No STL supplied. Material compatibility is unverified.',{exact:true})).toBeVisible();await userEvent.click(canvas.getByRole('button',{name:/Approve \$25.00/}));await expect(args.onApprove).toHaveBeenCalledTimes(1);}};
export const BuyerAgentCannotApprove:Story={args:{canApprove:false},play:async({canvasElement})=>{await expect(within(canvasElement).getByRole('button',{name:/Approve \$25.00/})).toBeDisabled();}};
export const AcceptedAndQueued:Story={args:{view:state('queued')}};
export const CompletedSimulation:Story={args:{view:state('completed_simulated')}};
export const FailedSimulation:Story={args:{view:state('failed_simulated')},play:async({canvasElement})=>{await expect(within(canvasElement).getByRole('heading',{name:'Failed · simulated'})).toBeVisible();}};
const over=structuredClone(quoted);over.exchange!.brief.budgetMinor=2000;over.exchange!.quote.blockers=['Quote exceeds the stated budget.'];
export const BudgetBlocksApproval:Story={args:{view:over},play:async({canvasElement})=>{await expect(within(canvasElement).getByRole('button',{name:/Approve \$25.00/})).toBeDisabled();}};
