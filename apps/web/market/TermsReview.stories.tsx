import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { TermsReview } from './components.tsx';

const meta = {
  title: 'Market/Frozen terms', component: TermsReview, tags: ['autodocs'],
  args: {
    description: 'Synthetic proposal. Posting and proposing do not commit either party; both approvals are required.',
    terms: [
      { label: 'Item / spec', value: 'Illustrative wall panel · spec revision 1' },
      { label: 'Proposed allocation', value: '8 each of 12 each demand' },
      { label: 'Unit price', value: '$125.00 USD / each' },
      { label: 'Origin', value: 'Synthetic depot A' },
      { label: 'Destination', value: 'Synthetic house site' },
      { label: 'Delivery deadline', value: 'Nov 12, 2026, 18:00 UTC' },
      { label: 'Terms revision', value: 'story-terms-1 · order revisions 1 / 1' },
    ],
  },
} satisfies Meta<typeof TermsReview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Representative: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText(/both approvals are required/)).toBeVisible();
    await expect(canvas.getByText('$125.00 USD / each')).toBeVisible();
  },
};
export const LongTerms: Story = {
  args: { terms: [{ label: 'Synthetic terms', value: 'Receiver acknowledgement records quantities under these illustrative terms. It does not certify inspection, regulatory compliance, assembly readiness, or payment. A manually linked component is not an automatically calculated house bill of materials.' }] },
};
