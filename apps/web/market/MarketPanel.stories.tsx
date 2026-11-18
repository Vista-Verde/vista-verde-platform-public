import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { MarketPanel, Stat } from './components.tsx';

const retry = fn();
const meta = {
  title: 'Market/Panel states', component: MarketPanel, tags: ['autodocs'],
  args: { title: 'Physical goods market', eyebrow: 'Synthetic component fixture', children: <p>Compare the same item and unit, then review explicit terms.</p> },
} satisfies Meta<typeof MarketPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Representative: Story = {
  args: { children: <div className="market-stats"><Stat label="Open demand" value="12 each"/><Stat label="Offered supply" value="12 each"/><Stat label="Suppliers" value={2}/></div> },
};
export const Loading: Story = {
  args: { children: <div className="market-loading" role="status" aria-live="polite">Loading market records…</div> },
  play: async ({ canvas }) => { await expect(canvas.getByRole('status')).toHaveTextContent('Loading market records'); },
};
export const Error: Story = {
  args: { children: <div className="market-note error" role="alert">Market records could not be loaded. Your saved request is available for retry.</div>, action: <button type="button" onClick={retry}>Retry saved request</button> },
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByRole('alert')).toHaveTextContent('saved request');
    await userEvent.click(canvas.getByRole('button', { name: 'Retry saved request' }));
    await expect(retry).toHaveBeenCalledOnce();
  },
};
