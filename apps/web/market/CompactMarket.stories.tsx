import type {Meta,StoryObj} from '@storybook/react-vite';
import {expect,fn} from 'storybook/test';
import {independentSupplies,supplyItems,workOrders} from '../../../.storybook/work-fixtures.ts';
import {ListingBrowser,orderRows} from './ListingBrowser.tsx';

const meta={title:'Market/Simple listings',component:ListingBrowser,args:{title:'Buy',rows:orderRows(independentSupplies,supplyItems),items:supplyItems,onSearch:fn(),post:{label:'Post supply listing',href:'#post-material'}},decorators:[Story=><div className="market-main"><h1 className="market-sr-only">Simple market preview</h1><Story/></div>]} satisfies Meta<typeof ListingBrowser>;
export default meta;type Story=StoryObj<typeof meta>;
export const Buy:Story={play:async({canvas,userEvent})=>{await userEvent.click(canvas.getByRole('button',{name:'Select Illustrative raw blocks'}));await expect(canvas.getByRole('region',{name:'Selected listing'})).toBeVisible();await expect(canvas.getByRole('link',{name:'Review supply →'})).toBeVisible();}};
export const WorkOrders:Story={args:{title:'Work orders',rows:orderRows(workOrders,supplyItems),post:{label:'Post a work order',href:'#post-work'}}};
export const FilterByCategory:Story={play:async({canvas,userEvent})=>{const toggle=canvas.queryByRole('button',{name:'Categories & filters'});if(toggle)await userEvent.click(toggle);await userEvent.click(canvas.getByRole('button',{name:/^Illustrative raw blocks/}));await expect(canvas.getAllByRole('button',{name:/^Select /})).toHaveLength(1);}};
export const KeyboardSelection:Story={play:async({canvas,userEvent})=>{const row=canvas.getByRole('button',{name:'Select Illustrative raw blocks'});row.focus();await userEvent.keyboard(' ');await expect(canvas.getByRole('link',{name:'Review supply →'})).toBeVisible();}};
export const LongContent:Story={args:{rows:orderRows([{...independentSupplies[0]!,need:'Material for a replacement production component with a deliberately long descriptive name',location:'A receiving location with a long description and no private delivery credentials'}],supplyItems)}};
export const Empty:Story={args:{rows:[]}};
