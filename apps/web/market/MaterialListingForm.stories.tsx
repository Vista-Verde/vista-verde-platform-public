import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { supplyItems, usedRawLot } from '../../../.storybook/work-fixtures.ts';
import { MaterialListingForm } from './work-forms.tsx';

const meta = {
  title: 'Supply/Post independent supply', component: MaterialListingForm, tags: ['autodocs'],
  args: { items: supplyItems, initialItemId: 'RAW-BLOCK-DEMO', disabled: false, onSubmit: fn(), onError: fn() },
} satisfies Meta<typeof MaterialListingForm>;
export default meta;
type Story = StoryObj<typeof meta>;
type PlayContext = Parameters<NonNullable<Story['play']>>[0];

async function enterSupply({ canvas, userEvent }: PlayContext, quantity = '10', price = '20.00') {
  const count = canvas.getByRole('spinbutton', { name: 'Quantity (each)' });
  await userEvent.clear(count);
  await userEvent.type(count, quantity);
  await userEvent.type(canvas.getByRole('spinbutton', { name: 'Unit price (USD)' }), price);
  await userEvent.type(canvas.getByRole('textbox', { name: /(Material|Supply) location/ }), 'Synthetic supply yard');
}
export const RawMaterialOnlySupplier: Story = {
  play: async (context) => {
    await enterSupply(context);
    await context.userEvent.click(context.canvas.getByRole('button', { name: /Post (material|supply) listing/ }));
    await expect(context.args.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'RAW-BLOCK-DEMO', quantity: { value: 10, unit: 'each' }, unitPrice: { minorUnits: 2000, currency: 'USD' } }));
    await expect(context.args.onSubmit).not.toHaveBeenCalledWith(expect.objectContaining({ workOrderId: expect.any(String) }));
  },
};
export const IntermediateOutput: Story = {
  args: { initialItemId: 'INTERMEDIATE-DEMO' },
  play: async (context) => {
    await enterSupply(context, '6', '40.00');
    await context.userEvent.click(context.canvas.getByRole('button', { name: /Post (material|supply) listing/ }));
    await expect(context.args.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'INTERMEDIATE-DEMO' }));
  },
};
export const FinishedComponentOutput: Story = { args: { initialItemId: 'PANEL-DEMO' } };
export const Loading: Story = { args: { disabled: true } };
export const EmptyCatalog: Story = { args: { items: [] } };
export const RelistTwoUnusedInputs: Story = {
  args: { sourceLot: usedRawLot },
  play: async (context) => {
    await expect(context.canvas.getByRole('spinbutton', { name: 'Quantity (each)' })).toHaveAttribute('max', '2');
    await enterSupply(context, '2');
    await context.userEvent.click(context.canvas.getByRole('button', { name: 'Post supply listing' }));
    await expect(context.args.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ sourceLotId: usedRawLot.lotId, quantity: { value: 2, unit: 'each' } }));
    await expect(context.args.onError).not.toHaveBeenCalled();
  },
};
export const UsedQuantityCannotBeRelisted: Story = {
  args: { sourceLot: usedRawLot },
  play: async (context) => {
    await enterSupply(context, '3');
    await context.userEvent.click(context.canvas.getByRole('button', { name: 'Post supply listing' }));
    await expect(context.args.onSubmit).not.toHaveBeenCalled();
    await expect((context.canvas.getByRole('form', { name: 'Post material listing' }) as HTMLFormElement).checkValidity()).toBe(false);
  },
};
