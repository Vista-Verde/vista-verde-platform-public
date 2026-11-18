import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { independentSupplies, panelWorkOrder } from '../../../.storybook/work-fixtures.ts';
import { MaterialSourceForm } from './work-forms.tsx';

const meta = {
  title: 'Supply/Manual sourcing candidate', component: MaterialSourceForm, tags: ['autodocs'],
  args: { workOrder: panelWorkOrder, listings: independentSupplies, disabled: false, onSubmit: fn(), onError: fn() },
} satisfies Meta<typeof MaterialSourceForm>;
export default meta;
type Story = StoryObj<typeof meta>;
export const NonbindingCandidate: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const quantity = canvas.getByRole('spinbutton', { name: 'Source quantity (each)' });
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '8');
    await userEvent.click(canvas.getByRole('button', { name: 'Link supply candidate' }));
    await expect(args.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ workOrderId: panelWorkOrder.orderId, materialListingId: 'story-raw-supply', quantity: { value: 8, unit: 'each' } }));
    await expect(canvas.getByText(/quantity is not reserved/)).toBeVisible();
    await expect(args.onError).not.toHaveBeenCalled();
  },
};
export const EmptySupply: Story = {
  args: { listings: [] },
  play: async ({ canvas }) => { await expect(canvas.getByRole('button', { name: 'Link supply candidate' })).toBeDisabled(); },
};
export const Loading: Story = { args: { disabled: true } };
