import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { demoWorkspace } from '../../../.storybook/fixtures.ts';
import { producerResponse, supplyItems } from '../../../.storybook/work-fixtures.ts';
import { MarketPageView } from './pages.tsx';

const meta = {
  title: 'Work orders/Frozen response terms', component: MarketPageView,
  args: { page: { kind: 'proposal', proposal: producerResponse }, workspace: demoWorkspace, items: supplyItems, actions: { blocked: false, command: fn(), refresh: fn(), message: fn() } },
  render: (args) => <><p className="market-note">Frozen stated budget and all-in output terms. This fixture claims no escrow, verified funding, payment or automatic input procurement.</p><MarketPageView {...args}/></>,
} satisfies Meta<typeof MarketPageView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ExplicitBuyerApproval: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByText('Buyer total stated budget').parentElement).toHaveTextContent('$1,200.00');
    const confirm = canvas.getByRole('button', { name: 'Confirm frozen terms' });
    await expect(confirm).toBeDisabled();
    await userEvent.click(canvas.getByRole('checkbox', { name: 'I approve these frozen terms for my business.' }));
    await userEvent.click(confirm);
    await expect(args.actions.command).toHaveBeenCalledWith('confirmMarketProposal', { proposalId: producerResponse.proposalId, expectedRecordVersion: 1 }, expect.any(String));
  },
};
export const SnapshotBudgetRemainsFrozen: Story = {
  args: { workspace: { ...demoWorkspace, orders: [{ ...producerResponse.buyOrderSnapshot, remainingBudget: { minorUnits: 48000, currency: 'USD' }, budgetCommitted: { minorUnits: 72000, currency: 'USD' }, recordVersion: 3 }] } },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Budget available at proposal').parentElement).toHaveTextContent('$1,200.00');
    await expect(canvas.getByText('Price scope').parentElement).toHaveTextContent('Separate input purchases are not added again.');
  },
};
