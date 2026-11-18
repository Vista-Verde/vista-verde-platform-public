import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { storyBuyOrder, storySellOrder } from '../../../.storybook/fixtures.ts';
import { AllocationForm } from './forms.tsx';

const meta = {
  title: 'Market/Allocation proposal form', component: AllocationForm, tags: ['autodocs'],
  args: { buyOrder: storyBuyOrder, sellOrder: storySellOrder, disabled: false, onSubmit: fn(), onError: fn() },
} satisfies Meta<typeof AllocationForm>;
export default meta;
type Story = StoryObj<typeof meta>;

export const PartialFill: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const quantity = canvas.getByRole('spinbutton', { name: 'Proposed quantity (each)' });
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '4');
    await userEvent.click(canvas.getByRole('button', { name: 'Propose allocation' }));
    await expect(args.onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      buyOrderId: 'story-demand-panels', sellOrderId: 'story-supply-a', expectedBuyVersion: 1, expectedSellVersion: 1,
      quantity: { value: 4, unit: 'each' }, unitPrice: { minorUnits: 12500, currency: 'USD' },
    }));
    await expect(args.onError).not.toHaveBeenCalled();
  },
};
export const PriceMismatch: Story = {
  args: { sellOrder: { ...storySellOrder, unitPrice: { minorUnits: 13000, currency: 'USD' } } },
  play: async ({ canvas }) => { await expect(canvas.getByText(/Posted prices differ/)).toBeVisible(); },
};
export const IncompatibleSpecification: Story = {
  args: { sellOrder: { ...storySellOrder, specificationRevision: 2 } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('alert')).toHaveTextContent('cannot be proposed');
    await expect(canvas.queryByRole('button', { name: 'Propose allocation' })).not.toBeInTheDocument();
  },
};
export const EmptyQuantity: Story = {
  args: { sellOrder: { ...storySellOrder, remainingQuantity: { value: 0, unit: 'each' } } },
  play: async ({ canvas }) => { await expect(canvas.getByText(/no open quantity/)).toBeVisible(); },
};
export const Loading: Story = { args: { disabled: true } };
