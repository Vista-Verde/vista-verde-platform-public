import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { independentSupplies, producerWorkspace, supplyItems } from '../../../.storybook/work-fixtures.ts';
import { MaterialListingsView } from './work-views.tsx';

const meta = {
  title: 'Supply/Independent listings', component: MaterialListingsView,
  args: { listings: independentSupplies, items: supplyItems, workspace: producerWorkspace, actions: { blocked: false, command: fn(), refresh: fn(), message: fn() }, onSearch: fn() },
  render: (args) => <div className="market-main"><MaterialListingsView {...args}/></div>,
} satisfies Meta<typeof MaterialListingsView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const RawIntermediateAndFinishedOutputs: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('button',{name:'Select Illustrative raw blocks'})).toBeVisible();
    await expect(canvas.getByRole('button',{name:'Select Illustrative intermediate blanks'})).toBeVisible();
    await expect(canvas.getByRole('button',{name:'Select Illustrative wall panels'})).toBeVisible();

    const document = canvasElement.ownerDocument;
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
  },
};
export const RawMaterialOnlySupplier: Story = { args: { listings: [independentSupplies[0]!] } };
export const Empty: Story = { args: { listings: [] } };
export const Loading: Story = { args: { actions: { ...meta.args.actions, blocked: true } } };
