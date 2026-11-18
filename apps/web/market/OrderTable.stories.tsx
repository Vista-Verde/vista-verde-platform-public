import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';
import { storyDemand, storySupplies } from '../../../.storybook/fixtures.ts';
import { OrderTable } from './components.tsx';

const meta = {
  title: 'Market/Order table', component: OrderTable, tags: ['autodocs'],
  args: { title: 'Buy demand · synthetic panels', side: 'buy', orders: [storyDemand], onSelect: fn() },
} satisfies Meta<typeof OrderTable>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Representative: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const table = canvas.getByRole('table');
    await expect(within(table).getByText('USD / each')).toBeVisible();
    await expect(within(table).getByText('Synthetic house site')).toBeVisible();
    await userEvent.click(canvas.getByRole('radio', { name: /Synthetic House Cooperative/ }));
    await expect(args.onSelect).toHaveBeenCalledWith(storyDemand.id);
  },
};
export const SellSupply: Story = {
  args: { title: 'Sell supply · synthetic panels', side: 'sell', orders: storySupplies },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('In stock')).toBeVisible();
    await expect(canvas.getByText('Made to order')).toBeVisible();
    await expect(canvas.getAllByRole('radio')).toHaveLength(2);
  },
};
export const PartialFill: Story = {
  args: { orders: [{ ...storyDemand, openQuantity: 4, recordVersion: 2 }], ownOrganizationId: storyDemand.organizationId },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('of 12 posted')).toBeVisible();
    await expect(canvas.getByText(/Your business/)).toBeVisible();
    await expect(canvas.getByRole('table')).toHaveTextContent('4 each');
  },
};
export const Empty: Story = {
  args: { orders: [] },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('heading', { name: 'No buy demand yet' })).toBeVisible();
    await expect(canvas.queryByRole('table')).not.toBeInTheDocument();
  },
};
export const KeyboardSelection: Story = {
  args: { title: 'Sell supply · keyboard selection', side: 'sell', orders: storySupplies },
  play: async ({ args, canvas, userEvent }) => {
    const choice = canvas.getByRole('radio', { name: /Synthetic Panel Works A/ });
    await userEvent.tab();
    await expect(canvas.getByRole('link', { name: 'Open the persistent synthetic app →' })).toHaveFocus();
    await userEvent.tab();
    await expect(choice).toHaveFocus();
    await userEvent.keyboard(' ');
    await expect(args.onSelect).toHaveBeenCalledWith('story-supply-a');
  },
};
export const LongBusinessAndLocation: Story = {
  args: { orders: [{ ...storyDemand, organizationName: 'Synthetic Cooperative for Illustrative Housing Components and Materials', location: 'Synthetic northern receiving depot, illustration district, bay 12' }] },
  play: async ({ canvasElement }) => {
    const document = canvasElement.ownerDocument;
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
  },
};
