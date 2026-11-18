import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { storyItems } from '../../../.storybook/fixtures.ts';
import { OrderForm } from './forms.tsx';

const meta = {
  title: 'Market/Posting form', component: OrderForm, tags: ['autodocs'],
  args: { items: storyItems, initialItemId: 'story-panels', disabled: false, onSubmit: fn(), onError: fn() },
} satisfies Meta<typeof OrderForm>;
export default meta;
type Story = StoryObj<typeof meta>;
type PlayContext = Parameters<NonNullable<Story['play']>>[0];

async function enterOrder({ canvas, userEvent }: PlayContext) {
  const quantity = canvas.getByRole('spinbutton', { name: 'Quantity (each)' });
  await userEvent.clear(quantity);
  await userEvent.type(quantity, '12');
  await userEvent.type(canvas.getByRole('spinbutton', { name: 'Unit price (USD)' }), '125.00');
  await userEvent.type(canvas.getByRole('textbox', { name: 'Location' }), 'Synthetic house site');
}

export const Representative: Story = {
  play: async (context) => {
    await enterOrder(context);
    await context.userEvent.click(context.canvas.getByRole('button', { name: 'Post buy order' }));
    await expect(context.args.onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'story-panels', specificationRevision: 1, side: 'buy',
      quantity: { value: 12, unit: 'each' }, unitPrice: { minorUnits: 12500, currency: 'USD' },
      availableAt: expect.stringMatching(/Z$/), deliveryBy: expect.stringMatching(/Z$/),
    }));
    await expect(context.args.onError).not.toHaveBeenCalled();
  },
};
export const MadeToOrderSupply: Story = {
  args: { initialSide: 'sell' },
  play: async (context) => {
    await enterOrder(context);
    await context.userEvent.selectOptions(context.canvas.getByRole('combobox', { name: 'Supply mode' }), 'made_to_order');
    await context.userEvent.click(context.canvas.getByRole('button', { name: 'Post sell order' }));
    await expect(context.args.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ side: 'sell', supplyMode: 'made_to_order' }));
  },
};
export const RequiredFields: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Post buy order' }));
    await expect(args.onSubmit).not.toHaveBeenCalled();
    await expect((canvas.getByRole('form', { name: 'Post market order' }) as HTMLFormElement).checkValidity()).toBe(false);
  },
};
export const Loading: Story = {
  args: { disabled: true },
  play: async ({ canvas }) => { await expect(canvas.getByRole('button', { name: 'Post buy order' })).toBeDisabled(); },
};
export const EmptyCatalog: Story = {
  args: { items: [] },
  play: async ({ canvas }) => { await expect(canvas.getByRole('button', { name: 'Post buy order' })).toBeDisabled(); },
};
