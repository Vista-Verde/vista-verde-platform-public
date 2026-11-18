import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { demoHouseProject, demoItems } from '../../../.storybook/fixtures.ts';
import { HouseProjectView } from './pages.tsx';

const meta = {
  title: 'Work orders/House work', component: HouseProjectView,
  args: { project: demoHouseProject, items: demoItems },
  render: (args) => <div className="market-main"><header className="market-workspace-header"><div><p className="market-eyebrow">Vista Verde / house demonstration</p><h1>One goal. Independent agreements.</h1><p>Non-persistent HOUSE-DEMO-1 fixture. Component progress remains separate from the whole-house commitment.</p></div></header><HouseProjectView {...args}/></div>,
} satisfies Meta<typeof HouseProjectView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const PartialFulfillment: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('progressbar', { name: 'House kits acknowledged' })).toHaveAttribute('value', '0');
    await expect(canvas.getAllByRole('progressbar', { name: 'Acknowledged' })[0]!).toHaveAttribute('value', '5');
    await expect(canvas.getByText('0 each uncommitted · 7 each committed but unfulfilled')).toBeVisible();
    const document = canvasElement.ownerDocument;
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
  },
};
export const CompletedPanels: Story = {
  args: { project: { ...demoHouseProject, componentOrders: [{ ...demoHouseProject.componentOrders[0]!, reportedQuantity: { value: 12, unit: 'each' }, acknowledgedQuantity: { value: 12, unit: 'each' } }, ...demoHouseProject.componentOrders.slice(1)] } },
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole('progressbar', { name: 'Acknowledged' })[0]!).toHaveAttribute('value', '12');
    await expect(canvas.getByRole('progressbar', { name: 'House kits acknowledged' })).toHaveAttribute('value', '0');
  },
};
export const NoComponentLinks: Story = {
  args: { project: { ...demoHouseProject, componentOrders: [] } },
};
