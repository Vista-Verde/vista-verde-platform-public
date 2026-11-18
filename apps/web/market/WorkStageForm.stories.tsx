import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { stageWorkOrders } from '../../../.storybook/work-fixtures.ts';
import { WorkStageForm } from './work-forms.tsx';

const meta = {
  title: 'Supply/Manual stage references', component: WorkStageForm, tags: ['autodocs'],
  args: { orders: stageWorkOrders, disabled: false, onSubmit: fn(), onError: fn() },
} satisfies Meta<typeof WorkStageForm>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ExplicitReference: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Link work stages' }));
    await expect(args.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ upstreamWorkOrderId: stageWorkOrders[0]!.orderId, downstreamWorkOrderId: stageWorkOrders[1]!.orderId }));
    await expect(args.onError).not.toHaveBeenCalled();
  },
};
export const SameStageBlocked: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Downstream work order' }), stageWorkOrders[0]!.orderId);
    await userEvent.click(canvas.getByRole('button', { name: 'Link work stages' }));
    await expect(args.onSubmit).not.toHaveBeenCalled();
    await expect(args.onError).toHaveBeenCalledWith(expect.stringMatching(/distinct work orders/));
  },
};
export const TooFewStages: Story = { args: { orders: [stageWorkOrders[0]!] } };
