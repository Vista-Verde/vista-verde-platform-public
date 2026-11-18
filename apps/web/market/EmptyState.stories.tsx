import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { EmptyState } from './components.tsx';

const meta = {
  title: 'Market/Empty state', component: EmptyState, tags: ['autodocs'],
  args: { title: 'No orders for this item', children: <p>Post buy demand or sell supply with compatible item specifications and units.</p> },
} satisfies Meta<typeof EmptyState>;
export default meta;
type Story = StoryObj<typeof meta>;
export const NoOrders: Story = { play: async ({ canvas }) => { await expect(canvas.getByRole('heading', { name: 'No orders for this item' })).toBeVisible(); } };
export const NoSearchResults: Story = { args: { title: 'No items match your search', children: <p>Try a different item name or category.</p> } };
export const NoCommitments: Story = { args: { title: 'No commitments yet', children: <p>A proposal becomes a commitment only after both parties explicitly approve the same frozen terms.</p> } };
