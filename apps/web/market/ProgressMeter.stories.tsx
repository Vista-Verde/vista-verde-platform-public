import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { MarketPanel, ProgressMeter } from './components.tsx';

const meta = {
  title: 'Market/Fulfillment progress', component: ProgressMeter, tags: ['autodocs'],
  args: { label: 'Receiver acknowledged panels', value: 5, total: 8 },
} satisfies Meta<typeof ProgressMeter>;
export default meta;
type Story = StoryObj<typeof meta>;

export const PartialFulfillment: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('progressbar', { name: 'Receiver acknowledged panels' })).toHaveAttribute('value', '5');
    await expect(canvas.getByText('5 / 8')).toBeVisible();
  },
};
export const AwaitingAcknowledgement: Story = { args: { value: 0 } };
export const Complete: Story = { args: { value: 8 } };
export const Empty: Story = { args: { value: 0, total: 0 } };
export const TwoSuppliers: Story = {
  render: () => <MarketPanel title="Synthetic panel commitments" eyebrow="Separate commitments · same demand">
    <div className="market-progress-grid">
      <ProgressMeter label="Supplier A · receiver acknowledged" value={5} total={8}/>
      <ProgressMeter label="Supplier B · receiver acknowledged" value={0} total={4}/>
    </div>
    <p className="market-note">12 each allocated across two suppliers. 5 each acknowledged. Seller reports await separate acknowledgement; the whole house remains separate.</p>
  </MarketPanel>,
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole('progressbar')).toHaveLength(2);
    await expect(canvas.getByText(/whole house remains separate/)).toBeVisible();
  },
};
