import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { storyCommitment } from '../../../.storybook/fixtures.ts';
import { independentSupplies, materialSourceLinks, panelWorkOrder, producerResponse, producerWorkspace, supplyItems } from '../../../.storybook/work-fixtures.ts';
import { WorkOrderDetailView } from './work-views.tsx';

const meta = {
  title: 'Work orders/Need and progress', component: WorkOrderDetailView, tags: ['autodocs'],
  args: { workOrder: panelWorkOrder, items: supplyItems, workspace: producerWorkspace, actions: { blocked: false, command: fn(), refresh: fn(), message: fn() }, materialSourceLinks: [] },
} satisfies Meta<typeof WorkOrderDetailView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const NoPublicListingRequired: Story = {};
export const StatedBudget: Story = {
  play: async ({ canvas }) => { await expect(canvas.getByText('Stated budgets are intent limits; no funds are held.')).toBeVisible(); },
};
export const NonbindingSourceCandidate: Story = {
  args: { materialSourceLinks, materialListings: independentSupplies },
  play: async ({ canvas }) => { await expect(canvas.getByText('Manual · nonbinding')).toBeVisible(); },
};
export const PartialFulfillment: Story = {
  args: {
    workOrder: { ...panelWorkOrder, allocatedQuantity: { value: 8, unit: 'each' }, remainingQuantity: { value: 4, unit: 'each' }, reportedQuantity: { value: 5, unit: 'each' }, acknowledgedQuantity: { value: 5, unit: 'each' }, budgetCommitted: { minorUnits: 72000, currency: 'USD' }, remainingBudget: { minorUnits: 48000, currency: 'USD' }, recordVersion: 3 },
    workspace: { ...producerWorkspace, proposals: [producerResponse], commitments: [{ ...storyCommitment, ...producerResponse, commitmentId: 'story-work-commitment', state: 'in_progress', reportedQuantity: { value: 5, unit: 'each' }, acknowledgedQuantity: { value: 5, unit: 'each' }, remainingQuantity: { value: 3, unit: 'each' } }] },
  },
  play: async ({ canvas }) => { await expect(canvas.getAllByRole('progressbar', { name: 'Receiver acknowledged' })[0]!).toHaveAttribute('value', '5'); },
};
export const SourcingError: Story = { args: { sourcesError: 'Synthetic supply candidates could not be loaded. Refresh to review current listings.' } };
