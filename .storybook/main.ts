import type { StorybookConfig } from '@storybook/react-vite';

const staticBuild = process.env.VV_STORYBOOK_STATIC_BUILD === '1';

const config: StorybookConfig = {
  framework: '@storybook/react-vite',
  stories: ['../apps/pitch/**/*.stories.tsx', '../apps/web/producer-exchange/**/*.stories.tsx', '../apps/web/market/**/*.stories.tsx', '../apps/payment-economics/**/*.stories.tsx', '../apps/research/**/*.stories.tsx', '../apps/architecture/**/*.stories.tsx', '../apps/print-demo/**/*.stories.tsx'],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y', ...staticBuild ? [] : ['@storybook/addon-vitest']],
  core: { disableTelemetry: true, enableCrashReports: false },
  async viteFinal(config) {
    return {
      ...config,
      // Keep development/test URLs unchanged; the reviewed static preview is
      // mounted beneath the app's hostname without root asset/API collisions.
      base: staticBuild ? '/storybook/' : config.base,
      // No stories use sb.mock. The production artifact needs neither the Vitest
      // panel nor Vite's injected module-mocking runtime and preview transformers.
      plugins: staticBuild ? config.plugins?.filter(plugin => !plugin || typeof plugin !== 'object' || !('name' in plugin) || ![
        'vite:storybook-inject-mocker-runtime', 'storybook:mock-loader', 'storybook:mock-loader-preview',
      ].includes(plugin.name)) : config.plugins,
      server: { ...config.server, host: '127.0.0.1' },
    };
  },
};

export default config;
