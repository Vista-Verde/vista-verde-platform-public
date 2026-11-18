import type {Meta,StoryObj} from '@storybook/react-vite';
import {expect} from 'storybook/test';
import {PrintDemo} from './PrintDemo.tsx';
import './style.css';
const meta={title:'Print/Mock 3D-print journey',component:PrintDemo,args:{appLink:true},parameters:{layout:'fullscreen'}} satisfies Meta<typeof PrintDemo>;
export default meta;
type Story=StoryObj<typeof meta>;
export const UploadRequired:Story={play:async({canvas,canvasElement})=>{
  await expect(canvas.getByText(/Upload required · no user design/)).toBeVisible();
  await expect(canvas.getByRole('button',{name:'Approve mock print terms'})).toBeDisabled();
  await expect(canvas.getByText(/Every quote, capacity, production event/)).toBeVisible();
  await expect(canvas.getByText(/File bytes and names stay in this tab/)).toBeVisible();
  const document=canvasElement.ownerDocument;await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
}};
export const SyntheticJourney:Story={play:async({canvas,userEvent,canvasElement})=>{
  await userEvent.click(canvas.getByRole('button',{name:'Load synthetic 20 mm cube'}));
  await expect(canvas.getByText(/Bundled synthetic test fixture · not your design/)).toBeVisible();
  await expect(canvas.getByText('$40.00')).toBeVisible();
  for(const name of ['Approve mock print terms','Approve mock delivery plan','Simulate printing','Simulate courier dispatch','Simulate delivered event']) await userEvent.click(canvas.getByRole('button',{name}));
  await expect(canvas.getByRole('button',{name:'Acknowledge simulated receipt'})).toBeVisible();
  await expect(canvas.queryByText('Simulated receipt acknowledged. No real goods moved.')).not.toBeInTheDocument();
  await userEvent.click(canvas.getByRole('button',{name:'Acknowledge simulated receipt'}));
  await expect(canvas.getByText('Simulated receipt acknowledged. No real goods moved.')).toBeVisible();
  const document=canvasElement.ownerDocument;await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
}};
export const IncompatibleAndChangedTerms:Story={args:{initialFixture:true},play:async({canvas,userEvent})=>{
  await userEvent.click(canvas.getByRole('button',{name:'Approve mock print terms'}));
  await userEvent.selectOptions(canvas.getByLabelText('Process and material'),'resin');
  await expect(canvas.getByRole('button',{name:'Approve mock print terms'})).toBeDisabled();
  await expect(canvas.queryByRole('button',{name:'Approve mock delivery plan'})).not.toBeInTheDocument();
  await userEvent.selectOptions(canvas.getByLabelText('Process and material'),'petg');
  await userEvent.selectOptions(canvas.getByLabelText('STL coordinate units'),'inch');
  await expect(canvas.getByText(/Bounds do not fit/)).toBeVisible();
}};
export const CustomerMaterialAcceptance:Story={args:{initialFixture:true},play:async({canvas,userEvent})=>{
  await userEvent.selectOptions(canvas.getByLabelText('Material responsibility'),'customer');
  await expect(canvas.getByRole('button',{name:'Approve mock print terms'})).toBeDisabled();
  await userEvent.click(canvas.getByRole('checkbox',{name:/Mock producer explicitly accepts/}));
  await expect(canvas.getByRole('button',{name:'Approve mock print terms'})).toBeEnabled();
  await expect(canvas.getByText('$36.00')).toBeVisible();
  await userEvent.clear(canvas.getByLabelText('Counted parts'));await userEvent.type(canvas.getByLabelText('Counted parts'),'2');
  await expect(canvas.getByRole('checkbox',{name:/Mock producer explicitly accepts/})).not.toBeChecked();
  await expect(canvas.getByRole('button',{name:'Approve mock print terms'})).toBeDisabled();
}};
