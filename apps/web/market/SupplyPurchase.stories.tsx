import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { independentSupplies, panelWorkOrder, producerWorkspace, supplyItems } from '../../../.storybook/work-fixtures.ts';
import { MaterialListingDetailView } from './work-views.tsx';

const inputNeed = { ...panelWorkOrder, orderId: 'story-raw-input-need', itemId: 'RAW-BLOCK-DEMO', organizationId: producerWorkspace.organizationId,
  need: 'Receive ten illustrative raw blocks for separately scoped intermediate production.', quantity: { value: 10, unit: 'each' as const }, remainingQuantity: { value: 10, unit: 'each' as const },
  unitPrice: { minorUnits: 2000, currency: 'USD' as const }, budget: { minorUnits: 20000, currency: 'USD' as const }, remainingBudget: { minorUnits: 20000, currency: 'USD' as const } };
const meta = {
  title: 'Supply/Explicit input purchase', component: MaterialListingDetailView,
  args: { listing: independentSupplies[0]!, items: supplyItems, workspace: { ...producerWorkspace, orders: [inputNeed] }, actions: { blocked: false, command: fn(), refresh: fn(), message: fn() } },
} satisfies Meta<typeof MaterialListingDetailView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const IndependentPurchaseProposal: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Propose allocation' }));
    await expect(args.actions.command).toHaveBeenCalledWith('proposeMarketAllocation', expect.objectContaining({ buyOrderId: inputNeed.orderId, sellOrderId: 'story-raw-supply', quantity: { value: 10, unit: 'each' } }), expect.any(String));
    await expect(canvas.getByText(/Source-candidate links remain nonbinding/)).toBeVisible();
  },
};
export const InputNeedRequired: Story = { args: { workspace: producerWorkspace } };
export const OwnSupply: Story = { args: { listing: { ...independentSupplies[0]!, organizationId: producerWorkspace.organizationId } } };
