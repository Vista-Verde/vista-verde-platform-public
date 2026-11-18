import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';
import { EconomicsModel, NetworkComparison, Waterfall } from './components.tsx';
import type { EconomicsModelProps } from './components.tsx';
import { baseScenario, evaluate, scenarios } from './model.ts';
import './style.css';

function FixtureNotice() {
  return <aside className="pe-fixture-notice" aria-label="Exploratory model boundary"><p>Synthetic assumptions · Local and non-persistent · Exploratory decision aid, not a forecast. No provider connection or market command is triggered. <a href="/app" target="_top">Open the persistent synthetic app →</a></p></aside>;
}
function ModelPreview(args:EconomicsModelProps) {
  return <div className="pe-app"><FixtureNotice/><EconomicsModel {...args}/></div>;
}
const meta = {
  title:'Economics/Exploratory model',component:EconomicsModel,
  args:{ initialScenario:baseScenario,onScenarioChange:fn() },
  render:args => <ModelPreview {...args}/>,
  parameters:{ layout:'fullscreen',docs:{ description:{ component:'Isolated synthetic USD model. Posted budgets, agreed work, paid goods and completed goods stay distinct. Monthly economics and the separate network fee boundary are never combined. Inputs are assumptions; fee policy, provider terms and commercial authority remain owner decisions.' } } }
} satisfies Meta<typeof EconomicsModel>;
export default meta;
type Story = StoryObj<typeof meta>;
const usd = (value:number) => new Intl.NumberFormat('en-US',{ style:'currency',currency:'USD',maximumFractionDigits:0 }).format(value);
function operatingValue(canvasElement:HTMLElement) {
  const span = [...canvasElement.querySelectorAll('.pe-metrics .pe-metric>span')].find(node => node.textContent === 'Net operating result');
  if (!span?.parentElement) throw new Error('The monthly operating metric is missing.');
  return within(span.parentElement).getByText(usd(evaluate(baseScenario).operating),{ selector:'strong' });
}
function assertPhoneLayout(canvasElement:HTMLElement) {
  const document = canvasElement.ownerDocument;
  return expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
}

export const Base:Story = {
  play:async ({ args,canvas,canvasElement,userEvent }) => {
    await expect(canvas.getByRole('heading',{ name:'What would the work order board earn?' })).toBeVisible();
    await expect(operatingValue(canvasElement)).toBeVisible();
    const stages = within(canvas.getByRole('table',{ name:'Monthly work order value — distinct stages, never added together' }));
    for (const name of ['Posted budget','Accepted contracted value','Paid goods GMV (before reversals)','Completed net paid goods value','Earned platform fee']) {
      await expect(stages.getByRole('rowheader',{ name })).toBeVisible();
    }
    const orders = canvas.getByRole('spinbutton',{ name:'Posted work orders per month' });
    await userEvent.clear(orders);
    await expect(orders).toHaveFocus();
    await userEvent.keyboard(String(baseScenario.orders+1));
    await expect(orders).toHaveValue(baseScenario.orders+1);
    await expect(args.onScenarioChange).toHaveBeenCalledWith(expect.objectContaining({ name:'Base',orders:baseScenario.orders+1 }));
    await userEvent.click(canvas.getByRole('button',{ name:'Reset this scenario' }));
    await expect(orders).toHaveValue(baseScenario.orders);
    await assertPhoneLayout(canvasElement);
  }
};
export const Conservative:Story = {
  args:{ initialScenario:scenarios.Conservative },
  play:async ({ canvas,canvasElement }) => {
    await expect(canvas.getByRole('button',{ name:'Conservative' })).toHaveAttribute('aria-pressed','true');
    await expect(canvas.getByTestId('break-even')).toHaveTextContent('No volume break-even.');
    await assertPhoneLayout(canvasElement);
  }
};
export const Upside:Story = {
  args:{ initialScenario:scenarios.Upside },
  play:async ({ canvas,canvasElement }) => {
    await expect(canvas.getByRole('button',{ name:'Upside' })).toHaveAttribute('aria-pressed','true');
    await expect(canvas.getByText('This scenario covers the modeled costs.',{ exact:true })).toBeVisible();
    await assertPhoneLayout(canvasElement);
  }
};
export const ZeroVolume:Story = {
  args:{ initialScenario:{ ...baseScenario,name:'Zero volume',orders:0 } },
  play:async ({ canvas,canvasElement }) => {
    await expect(canvas.getByRole('spinbutton',{ name:'Posted work orders per month' })).toHaveValue(0);
    await expect(canvas.getByTestId('break-even')).toHaveTextContent('No volume break-even.');
    const stages = within(canvas.getByRole('table',{ name:'Monthly work order value — distinct stages, never added together' }));
    await expect(stages.getByRole('row',{ name:'Posted budget $0' })).toBeVisible();
    await expect(stages.getByRole('row',{ name:'Paid goods GMV (before reversals) $0' })).toBeVisible();
    await assertPhoneLayout(canvasElement);
  }
};
export const SmallSplitOrder:Story = {
  args:{ initialScenario:{ ...baseScenario,name:'Small split order',aov:10,suppliers:3,rounds:2,chargeMode:'perSupplier' } },
  play:async ({ canvas,canvasElement,userEvent }) => {
    await userEvent.click(canvas.getByText('2. Suppliers, charges & payouts',{ selector:'summary' }));
    await expect(canvas.getByRole('spinbutton',{ name:'Suppliers per order' })).toHaveValue(3);
    await expect(canvas.getByRole('spinbutton',{ name:'Payment rounds per order' })).toHaveValue(2);
    await expect(canvas.getByRole('combobox',{ name:'Charge pattern' })).toHaveValue('perSupplier');
    await expect(canvas.getByText(/calculated once per work order and divided across charges/)).toBeVisible();
    await assertPhoneLayout(canvasElement);
  }
};
export const WaterfallOnly:Story = {
  render:() => <main className="pe-app pe-isolated-story"><FixtureNotice/><h1>Where modeled revenue goes.</h1><p>Synthetic monthly USD assumptions. Reimbursements, retained costs, contribution and fixed operations keep separate meanings.</p><Waterfall result={evaluate(baseScenario)}/></main>,
  play:async ({ canvas,canvasElement }) => {
    const table = within(canvas.getByRole('table',{ name:'Monthly platform waterfall, USD' }));
    await expect(table.getAllByRole('row')).toHaveLength(10);
    await expect(table.getByRole('rowheader',{ name:'Fixed operations' })).toBeVisible();
    await expect(table.getByRole('rowheader',{ name:'Net operating result' })).toBeVisible();
    await assertPhoneLayout(canvasElement);
  }
};
export const NetworkOnly:Story = {
  render:() => <main className="pe-app pe-isolated-story"><FixtureNotice/><h1>Distinct trades. Explicit fee boundaries.</h1><p>One synthetic network batch, separate from monthly totals. The selected end-customer boundary does not become a sum of material and component sales.</p><NetworkComparison scenario={baseScenario}/></main>,
  play:async ({ canvas,canvasElement,userEvent }) => {
    await expect(canvas.getByTestId('network-gross')).toHaveTextContent('$2,000');
    await expect(canvas.getByTestId('network-final')).toHaveTextContent('$1,000');
    const recovery = canvas.getByRole('checkbox',{ name:'Include a recovered-material trade for the next cycle' });
    recovery.focus();await userEvent.keyboard(' ');
    await expect(recovery).toBeChecked();
    await expect(canvas.getByTestId('network-gross')).toHaveTextContent('$2,150');
    await expect(canvas.getByTestId('network-final')).toHaveTextContent('$1,000');
    await userEvent.tab();
    const boundary = canvas.getByRole('combobox',{ name:'End-customer demand measurement boundary' });
    await expect(boundary).toHaveFocus();
    await userEvent.selectOptions(boundary,'component');
    await expect(canvas.getByTestId('network-final')).toHaveTextContent('$700');
    await expect(canvas.getByText('Illustrative fee policies — owner decision pending',{ selector:'caption' })).toBeVisible();
    await assertPhoneLayout(canvasElement);
  }
};
