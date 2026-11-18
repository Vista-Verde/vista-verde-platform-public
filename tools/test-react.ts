import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
await build({ entryPoints:['tests/foundation/react-components.test.tsx'],bundle:true,packages:'external',platform:'node',format:'esm',jsx:'automatic',target:'node26',outfile:'dist-tests/react-components.test.mjs' });
const result = spawnSync(process.execPath,['--test','tests/foundation/react.test.ts','dist-tests/react-components.test.mjs'],{ stdio:'inherit' });
process.exitCode = result.status ?? 1;
