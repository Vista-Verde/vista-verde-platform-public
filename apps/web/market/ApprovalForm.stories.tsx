import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { ApprovalForm } from './forms.tsx';

const meta = {
  title: 'Market/Explicit approval form', component: ApprovalForm, tags: ['autodocs'],
  args: { disabled: false, onApprove: fn() },
} satisfies Meta<typeof ApprovalForm>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ExplicitConfirmation: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const confirm = canvas.getByRole('button', { name: 'Confirm frozen terms' });
    await expect(confirm).toBeDisabled();
    await expect(args.onApprove).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole('checkbox', { name: 'I approve these frozen terms for my business.' }));
    await expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await expect(args.onApprove).toHaveBeenCalledOnce();
  },
};
export const KeyboardConfirmation: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.tab();
    await expect(canvas.getByRole('link', { name: 'Open the persistent synthetic app →' })).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.getByRole('checkbox')).toHaveFocus();
    await userEvent.keyboard(' ');
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'Confirm frozen terms' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onApprove).toHaveBeenCalledOnce();
  },
};
export const Loading: Story = { args: { disabled: true } };
