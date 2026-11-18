import type { Meta,StoryObj } from '@storybook/react-vite';
import { expect,within } from 'storybook/test';
import { ValidationPlan } from './components.tsx';
import './style.css';

const meta = { title:'Research/Validation plan',component:ValidationPlan,parameters:{ layout:'fullscreen' } } satisfies Meta<typeof ValidationPlan>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Overview:Story = {
  play:async ({ canvas,canvasElement }) => {
    await expect(canvas.getByRole('heading',{ name:'Validate the problem before the marketplace.' })).toBeVisible();
    await expect(canvas.getByText('Implemented synthetic behavior')).toBeVisible();
    await expect(canvas.getByText('Simulated scenarios')).toBeVisible();
    await expect(canvas.getByText('Business hypotheses')).toBeVisible();
    await expect(within(canvas.getByRole('list',{ name:'Five investor gaps' })).getAllByRole('listitem')).toHaveLength(5);
    const path = within(canvas.getByRole('list',{ name:'Six-step validation path' })).getAllByRole('listitem');
    await expect(path).toHaveLength(6);
    await expect(path[5]).toHaveTextContent('Separately authorized concierge pilot');
    await expect(canvas.getByText(/No verified demand, GMV, LOIs or marketplace liquidity/)).toBeVisible();
    await expect(canvas.getByText(/Audit logs alone are insufficient/)).toBeVisible();
    await expect(canvas.queryAllByRole('button')).toHaveLength(0);
    await expect(canvas.queryAllByRole('textbox')).toHaveLength(0);
    const document = canvasElement.ownerDocument;
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
  }
};
