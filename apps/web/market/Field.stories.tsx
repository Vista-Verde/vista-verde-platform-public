import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { Field } from './components.tsx';

const meta = {
  title: 'Market/Form field', component: Field, tags: ['autodocs'],
  args: { label: 'Quantity (each)', name: 'story-quantity', hint: 'Whole each units. Proposals do not reserve this quantity.', children: <input id="story-quantity" name="story-quantity" type="number" min="1" step="1" defaultValue="8" aria-describedby="story-quantity-hint"/> },
} satisfies Meta<typeof Field>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Representative: Story = {
  play: async ({ canvas, userEvent }) => {
    const quantity = canvas.getByRole('spinbutton', { name: 'Quantity (each)' });
    await userEvent.tab();
    await expect(canvas.getByRole('link', { name: 'Open the persistent synthetic app →' })).toHaveFocus();
    await userEvent.tab();
    await expect(quantity).toHaveFocus();
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '4');
    await expect(quantity).toHaveValue(4);
  },
};
export const Disabled: Story = { args: { children: <input id="story-quantity" type="number" value="8" disabled/> } };
export const Error: Story = {
  args: { hint: 'Quantity must be a positive whole number.', children: <input id="story-quantity" type="number" defaultValue="0" aria-invalid="true" aria-describedby="story-quantity-hint"/> },
};
