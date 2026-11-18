import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { AudiencePitch, audiencePitches, audienceStoryHref } from './AudiencePitch.tsx';
import type { Audience } from './AudiencePitch.tsx';
import './pitch.css';

const meta = { title: 'Platform/Audience pitches', component: AudiencePitch, args: { audience: 'overview' }, parameters: { layout: 'fullscreen', controls: { disable: true } } } satisfies Meta<typeof AudiencePitch>;
export default meta;
type Story = StoryObj<typeof meta>;

const verify: NonNullable<Story['play']> = async ({ canvas, canvasElement, args, userEvent }) => {
  const audience = args.audience ?? 'overview';
  await expect(canvas.getByRole('heading', { level: 1, name: audiencePitches[audience].title })).toBeVisible();
  const navigation = within(canvas.getByRole('navigation', { name: 'Audience pages' }));
  for (const key of Object.keys(audiencePitches) as Audience[]) {
    const link = navigation.getByRole('link', { name: audiencePitches[key].label });
    await expect(link).toHaveAttribute('href', audienceStoryHref(key));
    if (key === audience) await expect(link).toHaveAttribute('aria-current', 'page');
    else await expect(link).not.toHaveAttribute('aria-current');
  }
  const figure = canvas.getByRole('figure', { name: 'Proposed agent-first marketplace' });
  await expect(figure).toHaveAccessibleDescription(/Existing goods can go directly from suppliers to buyers/);
  await expect(figure).toHaveAccessibleDescription(/not a physical production step/);
  await expect(canvas.getByText('Agents coordinate. People approve commitments.')).toBeVisible();
  await expect(canvas.getByText(/Real quote, approval and status traffic with a separate simulated producer/)).toBeVisible();
  await expect(canvas.getByText(/Commercial demand, physical production, payments and authenticated remote MCP/)).toBeVisible();
  await expect(canvas.getByText(audiencePitches[audience].boundary)).toBeVisible();
  await expect(canvas.getByText(/Optional producer recovery is experimental and disabled by default\./)).not.toBeVisible();
  await userEvent.click(canvas.getByText('Technical proof and references'));
  await expect(canvas.getByText(/Optional producer recovery is experimental and disabled by default\./)).toBeVisible();
  const runtimeLink = canvas.getByRole('link', { name: 'Runtime and limits' });
  await expect(runtimeLink).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(runtimeLink).toHaveAttribute('href', 'https://github.com/Vista-Verde/vista-verde-platform-public/blob/main/RUNTIME.md');
  const snapshotLink = canvas.getByRole('link', { name: 'Public snapshot and limitations' });
  await expect(snapshotLink).toHaveAttribute('href', 'https://github.com/Vista-Verde/vista-verde-platform-public/blob/main/README.md');
  await expect(snapshotLink).toHaveAttribute('rel', 'noopener noreferrer');
  await userEvent.click(canvas.getByText('Technical proof and references'));
  await expect(canvas.getByText(/Optional producer recovery is experimental and disabled by default\./)).not.toBeVisible();
  navigation.getByRole('link', { name: 'Overview' }).focus();
  await userEvent.tab();
  await expect(navigation.getByRole('link', { name: 'Buyers' })).toHaveFocus();
  navigation.getByRole('link', { name: 'Buyers' }).blur();
  const document = canvasElement.ownerDocument;
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
  canvasElement.dataset.audiencePlayComplete = audience;
};

export const Overview: Story = { play: verify };
export const Buyers: Story = { args: { audience: 'buyers' }, play: verify };
export const MaterialAndComponentSuppliers: Story = { args: { audience: 'suppliers' }, play: verify };
export const Producers: Story = { args: { audience: 'producers' }, play: verify };
export const BackersAndNetworkPartners: Story = { args: { audience: 'backers' }, play: verify };
