import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { productionStorybook, storybookArtifactDigest } from '../apps/api/src/storybook.ts';

// Import a separately reviewed synthetic production build, never a dev server,
// source tree, credential directory or live database. The image owns this copy.
const source=resolve(process.argv[2] ?? 'storybook-static');
const target=resolve('dist/apps/storybook');
if (source === target || source.startsWith(target+'/') || target.startsWith(source+'/'))
  throw new Error('Artifact source and target must be separate.');
const media=/\.(html|js|css|json|svg|png|jpe?g|webp|gif|ico|woff2?)$/;
rmSync(target,{ recursive:true,force:true });mkdirSync(target,{ recursive:true });
function copy(directory:string,destination:string) {
  for (const entry of readdirSync(directory,{ withFileTypes:true })) {
    if (entry.isSymbolicLink()) throw new Error('Storybook artifact contains a symlink.');
    const from=join(directory,entry.name),to=join(destination,entry.name);
    if (entry.isDirectory()) { mkdirSync(to,{ recursive:true });copy(from,to); }
    else if (entry.isFile() && media.test(entry.name)) copyFileSync(from,to);
  }
}
copy(source,target);
const assets=productionStorybook(process.argv[3]);
console.log(`Synthetic production Storybook: ${assets.size-1} assets; SHA256 ${storybookArtifactDigest(assets)}.`);
