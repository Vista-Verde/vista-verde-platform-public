import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type StorybookAsset = { body:Buffer; type:string; policy:string };
export const STORYBOOK_MOUNT = '/storybook';

// Resolve only the fixed mount and exact in-memory artifact keys. Request text
// never selects a file, upstream origin, identity or application operation.
export function storybookRoute(url:string,assets:ReadonlyMap<string,StorybookAsset>):{asset?:StorybookAsset;redirect?:string} {
  const split=url.indexOf('?'),path=split<0?url:url.slice(0,split),query=split<0?'':url.slice(split);
  if(path===STORYBOOK_MOUNT)return{redirect:STORYBOOK_MOUNT+'/'+query};
  if(path.startsWith(STORYBOOK_MOUNT+'/')){
    const asset=assets.get(path.slice(STORYBOOK_MOUNT.length));return asset?{asset}:{};
  }
  if(path==='/'){
    const selected=new URLSearchParams(query),values=selected.getAll('path');
    if(values.length===1&&/^\/(story|docs)\/[a-z0-9][a-z0-9_-]{0,199}$/.test(values[0]!))
      return{redirect:STORYBOOK_MOUNT+'/'+query};
  }else if(assets.has(path))return{redirect:STORYBOOK_MOUNT+url};
  return{};
}
const media:Record<string,string>={ '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon',
  '.woff':'font/woff','.woff2':'font/woff2' };

// Static Storybook needs its own same-origin preview iframe and generated styles.
// Inline scripts are allowed only by hashes of this exact compiled HTML. API and
// working-app responses retain their stricter, independent policy.
function policy(body:Buffer,type:string):string {
  const hashes=type.startsWith('text/html') ? [...body.toString('utf8').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(match => !/\bsrc\s*=/i.test(match[1]!))
    .map(match => `'sha256-${createHash('sha256').update(match[2]!).digest('base64')}'`) : [];
  return `default-src 'none'; script-src 'self' ${hashes.join(' ')}; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'`;
}
export function storybookArtifactDigest(assets:ReadonlyMap<string,StorybookAsset>):string {
  const manifest=[...assets].filter(([path]) => path !== '/').sort(([a],[b]) => a < b ? -1:a > b ? 1:0)
    .map(([path,asset]) => `${path}\0${asset.body.length}\0${createHash('sha256').update(asset.body).digest('hex')}\n`).join('');
  return createHash('sha256').update(manifest).digest('hex');
}
export function productionStorybook(expectedDigest?:string):Map<string,StorybookAsset> {
  const root=new URL(import.meta.url.endsWith('.ts') ? '../../../dist/apps/storybook/' : '../../storybook/',import.meta.url);
  const assets=new Map<string,StorybookAsset>();
  let total=0;
  function visit(directory:URL,prefix:string) {
    for (const entry of readdirSync(directory,{ withFileTypes:true })) {
      // No symlinks, path traversal or filesystem reads derived from a request.
      if (entry.isSymbolicLink()) throw new Error('Storybook artifact contains a symlink.');
      const relative=prefix+entry.name;
      if (entry.isDirectory()) { visit(new URL(`${entry.name}/`,directory),`${relative}/`);continue; }
      const type=media[entry.name.slice(entry.name.lastIndexOf('.'))];
      if (!entry.isFile() || !type) continue;
      const body=readFileSync(join(directory.pathname,entry.name));
      total+=body.length;
      if (body.length>32*1024*1024 || total>128*1024*1024) throw new Error('Production Storybook artifact exceeds its static memory limit.');
      assets.set(`/${relative}`,{ body,type,policy:policy(body,type) });
    }
  }
  visit(root,'');
  const index=assets.get('/index.html');
  if (!index || !assets.has('/iframe.html') || !assets.has('/index.json')) throw new Error('Production Storybook artifact is incomplete.');
  if (expectedDigest !== undefined && (!/^[a-f0-9]{64}$/.test(expectedDigest) || storybookArtifactDigest(assets)!==expectedDigest))
    throw new Error('Production Storybook artifact does not match the reviewed digest.');
  assets.set('/',index);
  return assets;
}
