import { useState } from 'react';
import type { ComponentProps, MouseEvent } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';
import { independentSupplies, producerWorkspace, supplyItems, workOrders } from '../../../.storybook/work-fixtures.ts';
import { MaterialListingsView, MaterialPostingView, WorkOrderBoardView, WorkOrderDetailView, WorkOrderPostingView } from './work-views.tsx';

// Local navigation composes the real pure views. It never loads or substitutes API replies.
function BoardPreview(args: ComponentProps<typeof WorkOrderBoardView>) {
  const [selectedId, setSelectedId] = useState<string>();
  const [view, setView] = useState<'board' | 'supply' | 'post-work' | 'post-material'>('board');
  const [search, setSearch] = useState(args.search ?? '');
  const [notice, setNotice] = useState('');
  const selected = args.orders.find(order => order.orderId === selectedId);
  const actions = { ...args.actions, command: (...input: Parameters<typeof args.actions.command>) => {
    args.actions.command(...input);
    setNotice('The synthetic form was submitted locally. This fixture saves no shared records; use the persistent synthetic app to continue an agreement.');
  } };
  const navigate = (event: MouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return;
    const href = event.target.closest('a')?.getAttribute('href');
    const detailId = href?.match(/^#work\/([^?]+)/)?.[1];
    if (detailId && args.orders.some(order => order.orderId === decodeURIComponent(detailId))) {
      event.preventDefault(); setSelectedId(decodeURIComponent(detailId)); return;
    }
    const destination = ({ '#work-orders': 'board', '#materials': 'supply', '#post-work': 'post-work', '#post-material': 'post-material' } as const)[href as '#work-orders'];
    if (destination) { event.preventDefault(); setSelectedId(undefined); setView(destination); setSearch(''); }
  };
  const searchChanged = (value: string) => { args.onSearch?.(value); setSearch(value); };
  const filtered = args.orders.filter(order => !search || `${order.need} ${order.itemId} ${order.location}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="market-main" onClick={navigate}>
    <h1 className="market-sr-only">Work orders preview</h1>
    {notice && <p className="market-note" role="status">{notice}</p>}
    {selected ? <WorkOrderDetailView workOrder={selected} items={args.items} workspace={args.workspace} actions={actions} materialSourceLinks={[]} materialListings={[]}/> : view === 'supply' ? <MaterialListingsView listings={independentSupplies} items={supplyItems} workspace={args.workspace} actions={actions} search={search} onSearch={searchChanged}/> : view === 'post-work' ? <WorkOrderPostingView {...args} actions={actions}/> : view === 'post-material' ? <MaterialPostingView {...args} items={supplyItems} actions={actions}/> : <WorkOrderBoardView {...args} orders={filtered} actions={actions} search={search} onSearch={searchChanged}/>}
  </div>;
}
const meta = {
  title: 'Work orders/Work order board', component: WorkOrderBoardView,
  args: { orders: workOrders, items: supplyItems, workspace: producerWorkspace, actions: { blocked: false, command: fn(), refresh: fn(), message: fn() }, onSearch: fn() },
  render: (args) => <BoardPreview {...args}/>,
} satisfies Meta<typeof WorkOrderBoardView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Representative: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect(canvas.getByRole('heading', { name: 'Work orders' })).toBeVisible();
    await expect(within(canvas.getByRole('table')).getAllByRole('row')).toHaveLength(5);
    await userEvent.click(canvas.getByText('About work orders',{exact:true}));
    await expect(canvas.getByText(/not escrow or verified funding/)).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Browse independent supply listings →' })).toBeVisible();
    const document = canvasElement.ownerDocument;
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
  },
};
export const ProducerRespondsWithoutListing: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getAllByRole('button',{name:/^Select /})[0]!);
    await userEvent.click(canvas.getByRole('link', { name: 'Review need →' }));
    const quantity = canvas.getByRole('spinbutton', { name: 'Response quantity (each)' });
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '8');
    await userEvent.type(canvas.getByRole('spinbutton', { name: 'Response unit price (USD)' }), '90.00');
    await userEvent.type(canvas.getByRole('textbox', { name: 'Response origin' }), 'Synthetic workshop');
    await userEvent.click(canvas.getByRole('button', { name: 'Propose producer response' }));
    await expect(args.actions.command).toHaveBeenCalledWith('respondToWorkOrder', expect.objectContaining({ quantity: { value: 8, unit: 'each' }, unitPrice: { minorUnits: 9000, currency: 'USD' } }), expect.any(String));
    await expect(canvas.getByText(/fixture saves no shared records/)).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'No independent supply candidates available' })).toBeVisible();
  },
};
export const SearchConcreteNeed: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.type(canvas.getByRole('searchbox', { name: 'Search work orders' }), 'roof');
    await userEvent.click(canvas.getByRole('button', { name: 'Search' }));
    await expect(args.onSearch).toHaveBeenCalledWith('roof');
    await expect(canvas.getAllByRole('button', {name:/^Select /})).toHaveLength(1);
  },
};
export const Empty: Story = { args: { orders: [] } };
export const PartialCommitment: Story = {
  args: { orders: [{ ...workOrders[0]!, allocatedQuantity: { value: 8, unit: 'each' }, remainingQuantity: { value: 4, unit: 'each' }, budgetCommitted: { minorUnits: 72000, currency: 'USD' }, remainingBudget: { minorUnits: 48000, currency: 'USD' } }] },
};
export const Loading: Story = { args: { actions: { ...meta.args.actions, blocked: true } } };
