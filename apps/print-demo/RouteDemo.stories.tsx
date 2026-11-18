import type {Meta,StoryObj} from '@storybook/react-vite';
import {expect,within} from 'storybook/test';
import {RouteDemo} from './RouteDemo.tsx';
import './routes.css';
const meta={title:'Print/Coordinated route demo',component:RouteDemo,args:{appLink:true},parameters:{layout:'fullscreen'},decorators:[Story=><main><Story/></main>]} satisfies Meta<typeof RouteDemo>;
export default meta;
type Story=StoryObj<typeof meta>;
export const CompareAndDecide:Story={play:async({canvas,userEvent,canvasElement})=>{
 const a=within(canvas.getByRole('region',{name:'Mock route A'})),b=within(canvas.getByRole('region',{name:'Mock route B'}));
 await expect(a.getByText('$40.00',{exact:true})).toBeVisible();await expect(b.getByText('$46.00',{exact:true})).toBeVisible();
 await userEvent.click(canvas.getByRole('button',{name:'Simulate A material delay'}));
 const review=within(canvas.getByRole('region',{name:'Human plan review'}));
 await expect(review.getByText(/moving projected arrival to day 12/)).toBeVisible();
 await expect(review.getByRole('button',{name:'Approve recommended route B'})).toBeDisabled();
 await userEvent.click(review.getByRole('checkbox',{name:'I reviewed the synthetic route terms and tradeoffs.'}));
 await userEvent.click(review.getByRole('button',{name:'Approve recommended route B'}));
 await userEvent.click(review.getByRole('button',{name:'Freeze simulated agreement'}));
 await expect(review.getByText('SIM-RUN-1-AGREEMENT-B',{exact:true})).toBeVisible();
 await expect(canvasElement.ownerDocument.documentElement.scrollWidth).toBeLessThanOrEqual(canvasElement.ownerDocument.documentElement.clientWidth);
}};
export const RecommendationPending:Story={args:{initialScenario:'delay'},play:async({canvas})=>{
 await expect(canvas.getByRole('button',{name:'Approve recommended route B'})).toBeDisabled();
 await expect(canvas.getByText(/deterministic rule proposes this feasible alternative/)).toBeVisible();
}};
export const ApprovedPlan:Story={args:{initialScenario:'approved'},play:async({canvas})=>{await expect(canvas.getByRole('button',{name:'Freeze simulated agreement'})).toBeEnabled();}};
export const RejectedRecommendation:Story={args:{initialScenario:'rejected'},play:async({canvas})=>{
 await expect(canvas.getByRole('button',{name:'Selected route A'})).toBeDisabled();
 await expect(canvas.getByRole('button',{name:'Approve simulated plan'})).toBeDisabled();
 await expect(canvas.getByRole('status')).toHaveTextContent(/Human rejected the scripted suggestion/);
}};
export const NoFeasibleAlternative:Story={args:{initialScenario:'infeasible'},play:async({canvas,userEvent})=>{
 await userEvent.click(canvas.getByRole('button',{name:'Run scripted route check'}));
 await expect(canvas.getByRole('status')).toHaveTextContent(/The script found no eligible alternative/);
 await expect(canvas.getByRole('button',{name:'Approve simulated plan'})).toBeDisabled();
}};
export const FrozenAgreementDelay:Story={args:{initialScenario:'committed'},play:async({canvas,userEvent})=>{
 const review=within(canvas.getByRole('region',{name:'Human plan review'}));await userEvent.click(review.getByRole('button',{name:'Request route change — blocked'}));
 await expect(review.getByText('SIM-RUN-1-AGREEMENT-A',{exact:true})).toBeVisible();
 await expect(review.getByText('day 6 / day 12',{exact:true})).toBeVisible();
 await userEvent.click(canvas.getByRole('button',{name:'Start a new simulation'}));
 await userEvent.click(canvas.getByText('1 prior frozen simulation agreement',{exact:true}));
 await expect(canvas.getByText('SIM-RUN-1-AGREEMENT-A',{exact:true})).toBeVisible();
 await expect(canvas.getByText('RUN 2',{exact:true})).toBeVisible();
}};
export const ChangedTermsNeedReview:Story={args:{initialScenario:'changed'},play:async({canvas})=>{
 await expect(canvas.queryByRole('button',{name:'Freeze simulated agreement'})).not.toBeInTheDocument();
 await expect(canvas.getByRole('button',{name:'Approve simulated plan'})).toBeDisabled();
}};
export const DelegatedReviewRestricted:Story={args:{initialScenario:'delay',canReview:false},play:async({canvas})=>{
 await expect(canvas.getByRole('button',{name:'Approve recommended route B'})).toBeDisabled();
 await expect(canvas.getByRole('button',{name:'Reject recommendation'})).toBeDisabled();
 await expect(canvas.getByText(/participant lacks confirmation permission/)).toBeVisible();
}};
export const LocalStlRequired:Story={args:{initialScenario:'upload'},play:async({canvas,userEvent})=>{
 await expect(canvas.getByRole('button',{name:'Approve simulated plan'})).toBeDisabled();
 await userEvent.click(canvas.getByRole('button',{name:'Use synthetic 20 mm cube'}));
 await expect(canvas.getByText('Synthetic 20 mm cube · not your design',{exact:true})).toBeVisible();
}};
