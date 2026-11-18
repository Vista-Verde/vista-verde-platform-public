import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { receivedRawLot, relistedRawLot } from '../../../.storybook/work-fixtures.ts';
import { MaterialUseForm } from './work-forms.tsx';

const meta = {
  title: 'Supply/Record explicit input use', component: MaterialUseForm, tags: ['autodocs'],
  args: { lot: receivedRawLot, disabled: false, onSubmit: fn(), onError: fn() },
} satisfies Meta<typeof MaterialUseForm>;
export default meta;
type Story = StoryObj<typeof meta>;
export const EightOfTenUsed: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const quantity = canvas.getByRole('spinbutton', { name: 'Used quantity (each)' });
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '8');
    await userEvent.type(canvas.getByRole('textbox', { name: 'Use note' }), 'Eight synthetic raw blocks used for separately agreed intermediate work.');
    await userEvent.click(canvas.getByRole('button', { name: 'Record material use' }));
    await expect(args.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ lotId: receivedRawLot.lotId, expectedRecordVersion: 1, quantity: { value: 8, unit: 'each' } }));
    await expect(args.onError).not.toHaveBeenCalled();
  },
};
export const FullyUsedOrOffered: Story = {
  args: { lot: relistedRawLot },
  play: async ({ canvas }) => { await expect(canvas.getByRole('button', { name: 'Record material use' })).toBeDisabled(); },
};
export const Loading: Story = { args: { disabled: true } };
