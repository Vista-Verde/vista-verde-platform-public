import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// Optional existing local browser; CI keeps Playwright's pinned default.
const localChromium = process.env.VV_STORYBOOK_CHROMIUM_EXECUTABLE_PATH;

// The addon loads Storybook preview annotations and transforms CSF stories into tests.
// These tests exercise synthetic component props; they do not start the app or its API.
export default defineConfig({
  plugins: [storybookTest({ configDir: dirname(fileURLToPath(import.meta.url)) })],
  server: { host: '127.0.0.1' },
  test: {
    name: 'storybook',
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(localChromium ? { launchOptions: { executablePath: localChromium } } : undefined),
      instances: [
        { browser: 'chromium', name: 'market-desktop', viewport: { width: 1440, height: 1080 } },
        { browser: 'chromium', name: 'market-mobile', viewport: { width: 390, height: 844 } },
      ],
    },
    fileParallelism: false,
    testTimeout: 15000,
  },
});
