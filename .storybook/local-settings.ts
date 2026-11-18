import { fileURLToPath } from 'node:url';
import { globalSettings } from 'storybook/internal/cli';

// Prime Storybook's process-local settings cache before its CLI starts. This keeps
// tool preferences inside the ignored workspace cache, without touching the owner's home.
await globalSettings(fileURLToPath(new URL('../node_modules/.cache/vv-storybook/settings.json', import.meta.url)));
