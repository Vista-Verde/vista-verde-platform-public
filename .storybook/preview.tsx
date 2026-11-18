import type { Preview } from '@storybook/react-vite';
import '../apps/web/market/market.css';
import './preview.css';
import '../apps/web/market/compact.css';

const preview: Preview = {
  decorators: [
    (Story, context) => ['Platform/', 'Economics/', 'Research/', 'Architecture/', 'Print/'].some(prefix => context.title.startsWith(prefix)) ? <Story /> : (
      <main className="market-root storybook-market" aria-label="Synthetic market component preview">
        <h1 className="market-sr-only">Vista Verde synthetic market</h1>
        <h2 className="market-sr-only">Component preview</h2>
        <p className="storybook-fixture-notice">Synthetic component fixture · interactions are local and non-persistent. <a href="/app" target="_top">Open the persistent synthetic app →</a></p>
        <Story />
      </main>
    ),
  ],
  parameters: {
    layout: 'fullscreen',
    a11y: {
      test: 'error',
      options: { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    },
    controls: { expanded: true },
    options: { storySort: { order: ['Platform', 'Print', ['Persistent job workspace', 'Coordinated route demo', 'Mock 3D-print journey', '*'], 'Work orders', ['Work order board', 'House work', '*'], 'Supply', 'Demo', 'Architecture', 'Economics', 'Research', 'Market'] } },
  },
};

export default preview;
