import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stat } from './components.tsx';

const meta = {
  title: 'Market/Market stat', component: Stat, tags: ['autodocs'],
  args: { label: 'Open demand', value: '4 each', detail: '8 each already allocated of 12 each posted' },
} satisfies Meta<typeof Stat>;
export default meta;
type Story = StoryObj<typeof meta>;
export const PartialFill: Story = {};
export const Empty: Story = { args: { value: '0 each', detail: 'No unallocated quantity remains' } };
export const UnitPrice: Story = { args: { label: 'Unit price', value: '$125.00', detail: 'USD / each · synthetic terms' } };
