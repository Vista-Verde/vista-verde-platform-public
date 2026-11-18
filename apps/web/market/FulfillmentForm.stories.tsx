import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { storyCommitment } from '../../../.storybook/fixtures.ts';
import { FulfillmentForm } from './forms.tsx';

const meta = {
  title: 'Market/Fulfillment report form', component: FulfillmentForm, tags: ['autodocs'],
  args: { commitment: storyCommitment, disabled: false, onSubmit: fn(), onError: fn() },
} satisfies Meta<typeof FulfillmentForm>;
export default meta;
type Story = StoryObj<typeof meta>;

export const PartialFulfillment: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const quantity = canvas.getByRole('spinbutton', { name: 'Report quantity (each)' });
    await expect(quantity).toHaveAttribute('max', '3');
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '2');
    await userEvent.type(canvas.getByRole('textbox', { name: 'Report note' }), 'Synthetic two-panel update');
    await userEvent.click(canvas.getByRole('button', { name: 'Report fulfillment' }));
    await expect(args.onSubmit).toHaveBeenCalledWith({ commitmentId: 'story-commitment-a', expectedRecordVersion: 2, quantity: { value: 2, unit: 'each' }, note: 'Synthetic two-panel update' });
    await expect(args.onError).not.toHaveBeenCalled();
  },
};
export const ReportedInFull: Story = {
  args: { commitment: { ...storyCommitment, reportedQuantity: { value: 8, unit: 'each' } } },
  play: async ({ canvas }) => { await expect(canvas.getByRole('button', { name: 'Report fulfillment' })).toBeDisabled(); },
};
export const Loading: Story = { args: { disabled: true } };
