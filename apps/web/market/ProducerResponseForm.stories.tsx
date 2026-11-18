import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { panelWorkOrder } from '../../../.storybook/work-fixtures.ts';
import { ProducerResponseForm } from './work-forms.tsx';

const meta = {
  title: 'Work orders/Producer response', component: ProducerResponseForm, tags: ['autodocs'],
  args: { workOrder: panelWorkOrder, disabled: false, onSubmit: fn(), onError: fn() },
} satisfies Meta<typeof ProducerResponseForm>;
export default meta;
type Story = StoryObj<typeof meta>;
type PlayContext = Parameters<NonNullable<Story['play']>>[0];

async function enterResponse({ canvas, userEvent }: PlayContext, quantity = '8', price = '90.00') {
  const count = canvas.getByRole('spinbutton', { name: 'Response quantity (each)' });
  await userEvent.clear(count);
  await userEvent.type(count, quantity);
  await userEvent.type(canvas.getByRole('spinbutton', { name: 'Response unit price (USD)' }), price);
  await userEvent.type(canvas.getByRole('textbox', { name: 'Response origin' }), 'Synthetic producer workshop');
}
export const NoPublicListingRequired: Story = {
  play: async (context) => {
    await enterResponse(context);
    await context.userEvent.click(context.canvas.getByRole('button', { name: 'Propose producer response' }));
    await expect(context.args.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ workOrderId: panelWorkOrder.orderId, expectedRecordVersion: 1, quantity: { value: 8, unit: 'each' }, unitPrice: { minorUnits: 9000, currency: 'USD' }, supplyMode: 'made_to_order' }));
    await expect(context.args.onSubmit).not.toHaveBeenCalledWith(expect.objectContaining({ materialListingId: expect.any(String) }));
    await expect(context.args.onError).not.toHaveBeenCalled();
    await expect(context.canvas.getByText(/does not publish a supply listing/)).toBeVisible();
  },
};
export const PartialResponse: Story = {
  play: async (context) => {
    await enterResponse(context, '4');
    await context.userEvent.click(context.canvas.getByRole('button', { name: 'Propose producer response' }));
    await expect(context.args.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ quantity: { value: 4, unit: 'each' } }));
  },
};
export const OverBudget: Story = {
  play: async (context) => {
    await enterResponse(context, '12', '125.00');
    await context.userEvent.click(context.canvas.getByRole('button', { name: 'Propose producer response' }));
    await expect(context.args.onSubmit).not.toHaveBeenCalled();
    await expect(context.args.onError).toHaveBeenCalledWith(expect.stringMatching(/remaining stated budget/));
  },
};
export const FullyAllocated: Story = {
  args: { workOrder: { ...panelWorkOrder, state: 'allocated', remainingQuantity: { value: 0, unit: 'each' } } },
  play: async ({ canvas }) => { await expect(canvas.getByRole('button', { name: 'Propose producer response' })).toBeDisabled(); },
};
export const Loading: Story = { args: { disabled: true } };
