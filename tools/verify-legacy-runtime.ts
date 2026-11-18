import { createHash } from 'node:crypto';
import { readFileSync,readdirSync } from 'node:fs';
import { join,resolve } from 'node:path';

// This frozen compiled runtime comes only from the inspected original app image.
// It is CLI-only compatibility code for original-database backups and rollback
// evidence. No HTTP request or environment input selects a filesystem path.
const root=resolve('legacy-dist');
const files:{path:string;bytes:number;sha256:string}[]=[];
function scan(directory:string,prefix='') {
  for (const entry of readdirSync(directory,{withFileTypes:true})) {
    if (entry.isSymbolicLink()) throw new Error('Frozen legacy runtime contains a symlink.');
    const path=prefix+entry.name,source=join(directory,entry.name);
    if (entry.isDirectory()) scan(source,path+'/');
    else if (entry.isFile()) {
      const bytes=readFileSync(source);
      files.push({path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
    } else throw new Error('Frozen legacy runtime contains an unsupported entry.');
  }
}
scan(root);files.sort((a,b)=>a.path<b.path ? -1:a.path>b.path ? 1:0);
if (!files.length || !files.some(file=>file.path==='apps/local/src/bootstrap.js') || !files.some(file=>file.path==='apps/local/src/snapshot.js'))
  throw new Error('Frozen legacy runtime is incomplete.');
const manifest=files.map(file=>`${file.path}\0${file.bytes}\0${file.sha256}\n`).join('');
const sha256=createHash('sha256').update(manifest).digest('hex');
const expected=process.argv[2];
if (expected && (!/^[a-f0-9]{64}$/.test(expected) || expected!==sha256)) throw new Error('Frozen legacy runtime checksum does not match the reviewed copy.');
console.log(JSON.stringify({format:'vista-verde-frozen-legacy-runtime.v1',sourceImage:'not-distributed-in-public-snapshot',sha256,files,bytes:files.reduce((sum,file)=>sum+file.bytes,0)}));
