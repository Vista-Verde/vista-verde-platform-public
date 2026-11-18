import type { Meta,StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { DemoOpportunities,demoOpportunities } from './components.tsx';
import './style.css';

const meta = { title:'Research/Demo opportunities',component:DemoOpportunities,parameters:{ layout:'fullscreen' } } satisfies Meta<typeof DemoOpportunities>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Overview:Story = {
  play:async ({ canvas,canvasElement,userEvent }) => {
    await expect(canvas.getByRole('heading',{ name:'Places to learn, discuss and demonstrate.' })).toBeVisible();
    await expect(canvas.getAllByRole('article')).toHaveLength(5);
    await expect(canvas.getByText(/America\/Chicago/)).toBeVisible();
    await expect(canvas.getByText(/Reported free in prior research; reconfirm admission/)).toBeVisible();
    await expect(canvas.getByText(/the dated event page states no price/)).toBeVisible();
    await expect(canvas.getByText(/owner-only private preview is not ready for a public trial/)).toBeVisible();
    for (const source of demoOpportunities.flatMap(opportunity => opportunity.sources)) {
      const link = canvas.getByRole('link',{ name:source.label });
      await expect(link).toHaveAttribute('href',source.url);
      await expect(link).toHaveAttribute('rel','noopener noreferrer');
    }
    const firstLink = canvas.getByRole('link',{ name:'HRG organizer' });
    firstLink.focus();
    await expect(firstLink).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.getByRole('link',{ name:'Pearland events' })).toHaveFocus();
    await expect(canvas.queryAllByRole('button')).toHaveLength(0);
    const document = canvasElement.ownerDocument;
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
  }
};
