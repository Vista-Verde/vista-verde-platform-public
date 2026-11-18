import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { demoBook, demoWorkspace } from '../../../.storybook/fixtures.ts';
import { MarketBookView } from './pages.tsx';

const meta = {
  title: 'Market/Item comparison', component: MarketBookView,
  args: { book: demoBook, workspace: demoWorkspace, actions: { blocked: false, command: fn(), refresh: fn(), message: fn() } },
  render: (args) => <div className="market-main"><header className="market-workspace-header"><div><p className="market-eyebrow">Vista Verde / physical goods</p><h1>A market for what you need.</h1><p>Compare synthetic buy demand and sell supply, then propose an allocation for explicit party approval. This fixture saves nothing.</p></div></header><MarketBookView {...args}/></div>,
} satisfies Meta<typeof MarketBookView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Representative: Story = {
  play: async ({ args, canvas, userEvent, canvasElement }) => {
    await expect(canvas.getAllByRole('table')).toHaveLength(2);
    await userEvent.click(canvas.getByRole('radio', { name: /Demo buyer/ }));
    await userEvent.click(canvas.getByRole('radio', { name: /Supplier A/ }));
    await expect(canvas.getByText(/Posted prices differ/)).toBeVisible();
    const quantity = canvas.getByRole('spinbutton', { name: 'Proposed quantity (each)' });
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '4');
    await userEvent.click(canvas.getByRole('button', { name: 'Propose allocation' }));
    await expect(args.actions.command).toHaveBeenCalledWith('proposeMarketAllocation', expect.objectContaining({ quantity: { value: 4, unit: 'each' } }), expect.any(String));
    const document = canvasElement.ownerDocument;
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
  },
};
export const Empty: Story = {
  args: { book: { ...demoBook, buyOrders: [], sellOrders: [] } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('heading', { name: 'No buy demand yet' })).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'No sell supply yet' })).toBeVisible();
  },
};
export const PartialFill: Story = {
  args: { book: { ...demoBook, buyOrders: [{ ...demoBook.buyOrders[0]!, allocatedQuantity: { value: 8, unit: 'each' }, remainingQuantity: { value: 4, unit: 'each' }, recordVersion: 2 }], sellOrders: [{ ...demoBook.sellOrders[1]! }] } },
  play: async ({ canvas }) => { await expect(canvas.getByText('of 12 posted')).toBeVisible(); },
};
export const Submitting: Story = { args: { actions: { ...meta.args.actions, blocked: true } } };
