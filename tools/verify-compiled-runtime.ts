import { createHash } from 'node:crypto';
import { readFileSync,readdirSync } from 'node:fs';
import { join,resolve } from 'node:path';

// Bind the independently typechecked/linted local build copied into the offline
// review image, including its fixed production Storybook. No request path enters
// this build-time filesystem traversal.
const root=resolve('dist'),files:{path:string;bytes:number;sha256:string}[]=[];
function scan(directory:string,prefix='') {
  for (const entry of readdirSync(directory,{withFileTypes:true})) {
    if (entry.isSymbolicLink()) throw new Error('Compiled runtime contains a symlink.');
    const path=prefix+entry.name,source=join(directory,entry.name);
    if (entry.isDirectory()) scan(source,path+'/');
    else if (entry.isFile()) {const bytes=readFileSync(source);files.push({path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
    else throw new Error('Compiled runtime contains an unsupported entry.');
  }
}
scan(root);files.sort((a,b)=>a.path<b.path ? -1:a.path>b.path ? 1:0);
for(const path of ['apps/local/src/serve.js','apps/local/src/work-store.js','apps/local/src/work-snapshot.js','apps/local/src/work-verify-restore.js','apps/producer-demo/serve.js','apps/producer-demo/server.js','apps/producer-demo/process.js','apps/producer-demo/requester.js','apps/producer-demo/protocol.js','apps/producer-demo/preview.js','apps/web/producer-exchange.js','apps/web/app.js','apps/storybook/index.html'])
  if(!files.some(file=>file.path===path))throw new Error('Compiled runtime is incomplete.');
const manifest=files.map(file=>`${file.path}\0${file.bytes}\0${file.sha256}\n`).join(''),sha256=createHash('sha256').update(manifest).digest('hex');
const expected=process.argv[2];if(expected&&(!/^[a-f0-9]{64}$/.test(expected)||expected!==sha256))throw new Error('Compiled runtime differs from the reviewed local build.');
// Cached runtime packages must match every exact production dependency pin.
const dependencies=(JSON.parse(readFileSync('package.json','utf8')) as {dependencies:Record<string,string>}).dependencies;
for(const [name,version] of Object.entries(dependencies)){
  if(!/^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(name)||!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Production dependency must be exactly pinned.');
  const installed=JSON.parse(readFileSync(join('node_modules',name,'package.json'),'utf8')) as {version:string};
  if(installed.version!==version)throw new Error('Cached production dependency differs from the candidate pin.');
}
console.log(JSON.stringify({format:'vista-verde-compiled-owner-work-runtime.v1',sha256,files,bytes:files.reduce((sum,file)=>sum+file.bytes,0),dependencies}));
