import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Only the production output enters the application image. Never copy source,
// sourcemaps or a dev server into the private static preview.
const source='storybook-static',target='dist/apps/storybook';
rmSync(target,{ recursive:true,force:true }); mkdirSync(target,{ recursive:true });
cpSync(source,target,{ recursive:true,filter:path => !path.endsWith('.map') });
if (!readdirSync(target).includes('index.html')) throw new Error('Production Storybook build is missing.');
console.log(`Production synthetic Storybook copied to ${join(target,'index.html')}.`);
