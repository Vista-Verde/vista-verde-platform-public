import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { receivedRawLot, relistedRawLot, sourcingFixture, stageWorkOrders, supplyItems, producerWorkspace } from '../../../.storybook/work-fixtures.ts';
import { MarketPanel } from './components.tsx';
import { InventoryView } from './work-views.tsx';

const meta = {
  title: 'Demo/Multi-stage work and supply', component: InventoryView,
  args: { sourcing: sourcingFixture, items: supplyItems, workspace: producerWorkspace, actions: { blocked: false, command: fn(), refresh: fn(), message: fn() }, workOrders: stageWorkOrders },
  render: (args) => <div className="market-main"><header className="market-workspace-header"><div><p className="market-eyebrow">Bounded synthetic stage illustration</p><h1>Inputs, outputs, and the next need.</h1><p>Raw supplier → intermediate inputs → component work → final consumer. Each arrow is a manual reference between independently agreed stages.</p></div></header>
    <MarketPanel title="Four separately scoped stages"><ol>
      <li>Raw-material-only supplier lists 10 illustrative blocks independently.</li>
      <li>An intermediate participant explicitly receives 10 blocks and records 8 used. Its 6 intermediate blanks are a separate output quantity.</li>
      <li>Component work requests 12 illustrative panels under its own stated budget and agreed output terms.</li>
      <li>A final consumer requests one illustrative house under its own independent agreement.</li>
    </ol><p className="market-note">The 2 unused, unoffered blocks may be explicitly offered back from their source lot. Input counts and output counts are not added; input and final-stage budgets are not summed as unique cost. No BOM, automated purchasing, cyclic execution or recycling process is inferred.</p></MarketPanel>
    <InventoryView {...args}/>
  </div>,
} satisfies Meta<typeof InventoryView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const EightUsedTwoAvailable: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText('8 used + 0 offered + 0 allocated + 2 available = 10 each')).toBeVisible();
    await expect(canvas.getByText('story-input-receipt')).toBeVisible();
    const document = canvasElement.ownerDocument;
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
  },
};
export const ReceivedInputs: Story = { args: { sourcing: { ...sourcingFixture, lots: [receivedRawLot] } } };
export const TwoRelistedWithProvenance: Story = {
  args: { sourcing: { ...sourcingFixture, lots: [relistedRawLot] } },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('8 used + 2 offered + 0 allocated + 0 available = 10 each')).toBeVisible();
    await expect(canvas.queryByRole('link', { name: 'Offer available remainder with provenance →' })).not.toBeInTheDocument();
  },
};
export const EmptyInventory: Story = { args: { sourcing: { lots: [], stageLinks: [], nextCursor: null } } };
