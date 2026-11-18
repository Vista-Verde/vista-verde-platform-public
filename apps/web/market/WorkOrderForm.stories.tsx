import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { workOrderItems } from '../../../.storybook/work-fixtures.ts';
import { WorkOrderForm } from './work-forms.tsx';

const meta = {
  title: 'Work orders/Post a concrete need', component: WorkOrderForm, tags: ['autodocs'],
  args: { items: workOrderItems, initialItemId: 'PANEL-DEMO', disabled: false, onSubmit: fn(), onError: fn() },
} satisfies Meta<typeof WorkOrderForm>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Representative: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.type(canvas.getByRole('textbox', { name: 'Concrete need' }), 'Produce and deliver 12 illustrative wall panels under demo-r1.');
    const quantity = canvas.getByRole('spinbutton', { name: 'Quantity (each)' });
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '12');
    await userEvent.type(canvas.getByRole('spinbutton', { name: 'Total budget (USD)' }), '1200.00');
    await userEvent.type(canvas.getByRole('textbox', { name: 'Delivery location' }), 'Synthetic house site');
    await userEvent.click(canvas.getByRole('button', { name: 'Post work order' }));
    await expect(args.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'PANEL-DEMO', quantity: { value: 12, unit: 'each' }, budget: { minorUnits: 120000, currency: 'USD' }, need: 'Produce and deliver 12 illustrative wall panels under demo-r1.' }));
    await expect(args.onError).not.toHaveBeenCalled();
    await expect(canvas.getByText(/Posting does not prove funding or move money/)).toBeVisible();
  },
};
export const RequiredNeedAndBudget: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Post work order' }));
    await expect(args.onSubmit).not.toHaveBeenCalled();
    await expect((canvas.getByRole('form', { name: 'Post work order' }) as HTMLFormElement).checkValidity()).toBe(false);
  },
};
export const Loading: Story = { args: { disabled: true } };
export const EmptyCatalog: Story = { args: { items: [] } };
