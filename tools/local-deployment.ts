import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,writeFileSync,statSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn,spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { backupLocal,restoreLocal,kube,kubectl,namespace,assertOwnedPod,assertOwnedWorkload,externalDrive } from './local-backup.ts';

const root=fileURLToPath(new URL('..',import.meta.url)),local=join(root,'.local');
const statefulset='vista-verde-local',chart=join(root,'infra/helm/vista-verde-platform');
function run(command: string,args: string[],input?: string) {
  const result=spawnSync(command,args,{ cwd:root,encoding:'utf8',input,maxBuffer:2*1024*1024 });
  if (result.status!==0) throw new Error(`Local operation failed (${command.split('/').at(-1)}).`);
  return result.stdout.trim();
}
function privateDirectory() {
  if (existsSync(local) && (lstatSync(local).isSymbolicLink() || !lstatSync(local).isDirectory())) throw new Error('Unsafe local configuration directory.');
  mkdirSync(local,{ recursive:true,mode:0o700 });
  if ((statSync(local).mode&0o077)!==0) throw new Error('Local configuration directory must be private.');
}
function preflight() {
  if (run('docker',['context','show'])!=='orbstack') throw new Error('Expected OrbStack Docker context.');
  if (run(kubectl,['config','current-context'])!=='orbstack') throw new Error('Expected OrbStack Kubernetes context.');
  const version=JSON.parse(run(kubectl,['--context','orbstack','version','-o','json']));
  if (Math.abs(Number(version.clientVersion.minor)-Number(version.serverVersion.minor))>1) throw new Error('Use the already-installed supported Kubernetes client.');
  const nodes=JSON.parse(run(kubectl,['--context','orbstack','get','nodes','-o','json']));
  if (nodes.items.length!==1 || nodes.items[0].status.nodeInfo.architecture!=='arm64') throw new Error('Expected one inspected ARM64 OrbStack node.');
}
function imageState() {
  const image=JSON.parse(readFileSync(join(local,'image.json'),'utf8')) as { tag:string;id:string;source:string };
  if (image.source!==sourceHash()) throw new Error('Runtime inputs changed; rebuild the local image first.');
  const info=JSON.parse(run('docker',['image','inspect',image.tag]))[0];
  if (info.Id!==image.id || info.Architecture!=='arm64') throw new Error('Local image identity mismatch.'); return image;
}
function sourceHash() {
  const hash=createHash('sha256');
  function tree(directory: string) {
    for (const name of readdirSync(join(root,directory)).sort()) {
      const path=join(directory,name);
      if (lstatSync(join(root,path)).isDirectory()) tree(path);
      else { hash.update(path); hash.update(readFileSync(join(root,path))); }
    }
  }
  for (const name of ['apps','packages','infra']) tree(name);
  for (const name of ['package.json','package-lock.json','tsconfig.json','tsconfig.build.json','tools/copy-schema.ts','tools/build-web.ts']) { hash.update(name); hash.update(readFileSync(join(root,name))); }
  return hash.digest('hex');
}
function credentials() {
  privateDirectory(); const path=join(local,'credentials.json');
  if (lstatSync(path).isSymbolicLink() || (statSync(path).mode&0o077)!==0) throw new Error('Unsafe credential file permissions.');
  const value=JSON.parse(readFileSync(path,'utf8')) as Record<string,string>;
  if (Object.keys(value).sort().join(',')!=='application-password,database-password,fixture-key' || Object.values(value).some(s => !/^[a-f0-9]{64}$/.test(s))) throw new Error('Invalid local credential file.'); return value;
}
function ownedNamespace() {
  const result=spawnSync(kubectl,['--context','orbstack','get','namespace',namespace,'-o','json'],{ encoding:'utf8' });
  if (result.status===0) {
    if (JSON.parse(result.stdout).metadata.labels?.['app.kubernetes.io/part-of']!=='vista-verde-local') throw new Error('Existing namespace is not project owned.'); return;
  }
  run(kubectl,['--context','orbstack','create','-f','-'],JSON.stringify({ apiVersion:'v1',kind:'Namespace',metadata:{ name:namespace,labels:{ 'app.kubernetes.io/part-of':'vista-verde-local' } } }));
}
function install() {
  preflight(); const image=imageState(),values=credentials(); ownedNamespace();
  const existing=spawnSync(kubectl,['--context','orbstack','--namespace',namespace,'get','secret','vista-verde-local-credentials','-o','json'],{ encoding:'utf8' });
  const data=Object.fromEntries(Object.entries(values).map(([key,value]) => [key,Buffer.from(value).toString('base64')]));
  if (existing.status===0) {
    if (JSON.parse(existing.stdout).metadata.labels?.['app.kubernetes.io/part-of']!=='vista-verde-local') throw new Error('Existing Secret is not project owned.');
    if (JSON.stringify(JSON.parse(existing.stdout).data)!==JSON.stringify(data)) {
      const found=JSON.parse(existing.stdout).data;
      if (Object.keys(found).length!==3 || Object.entries(data).some(([key,value]) => found[key]!==value)) throw new Error('Existing credentials differ; no secret rotation is automatic.');
    }
  } else kube(['create','-f','-'],JSON.stringify({ apiVersion:'v1',kind:'Secret',metadata:{ name:'vista-verde-local-credentials',labels:{ 'app.kubernetes.io/part-of':'vista-verde-local' } },type:'Opaque',data }));
  run('helm',['--kube-context','orbstack','upgrade','--install','vista-verde-local',chart,'--namespace',namespace,'--set-string',`appImage=${image.tag}`,'--wait','--timeout','120s']);
  assertOwnedPod(); console.log('Persistent synthetic local pod ready; data retained. Run local:open for loopback access.');
}
type ForwardState={ pid:number;id:string };
function forwardState(): ForwardState | undefined {
  const path=join(local,'forward.json'); if (!existsSync(path)) return;
  const value=JSON.parse(readFileSync(path,'utf8')) as ForwardState;
  if (!Number.isInteger(value.pid) || !/^[a-f0-9-]{36}$/.test(value.id)) throw new Error('Invalid forward process identity.');
  const args=spawnSync('ps',['-p',String(value.pid),'-o','args='],{ encoding:'utf8' }).stdout.trim();
  if (args.includes(resolve(root,'tools/local-deployment.ts')) && args.endsWith(`forward-worker ${value.id}`)) return value;
}
async function open() {
  preflight(); assertOwnedPod(); privateDirectory();
  if (!forwardState()) {
    const id=randomUUID(); const child=spawn(process.execPath,[resolve(root,'tools/local-deployment.ts'),'forward-worker',id],{ cwd:root,detached:true,stdio:'ignore' }); child.unref();
    writeFileSync(join(local,'forward.json'),JSON.stringify({ pid:child.pid,id })+'\n',{ mode:0o600 });
  }
  for (let attempt=0;attempt<40;attempt++) {
    try {
      const log=existsSync(join(local,'forward.log')) ? readFileSync(join(local,'forward.log'),'utf8') : '';
      if (forwardState() && log.includes('Forwarding from 127.0.0.1:4318 -> 4318') && (await fetch('http://127.0.0.1:4318/health/ready',{ signal:AbortSignal.timeout(1000) })).ok) { console.log('http://127.0.0.1:4318 — synthetic local-only workspace'); return; }
    } catch { /* readiness will retry without exposing connection details */ }
    await delay(250);
  }
  throw new Error('Loopback forwarding did not become healthy; inspect the bounded local forward log.');
}
async function forwardWorker() {
  let child:ReturnType<typeof spawn> | undefined; let stopped=false; let log='';
  const stop=() => { stopped=true; child?.kill('SIGTERM'); };
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  for (let attempt=0;attempt<10 && !stopped;attempt++) {
    log=''; writeFileSync(join(local,'forward.log'),log,{ mode:0o600 });
    child=spawn(kubectl,['--context','orbstack','--namespace',namespace,'port-forward','--address','127.0.0.1',`pod/${statefulset}-0`,'4318:4318'],{ stdio:['ignore','pipe','pipe'] });
    const append=(bytes:Buffer) => { log=(log+bytes.toString()).slice(-65536); writeFileSync(join(local,'forward.log'),log,{ mode:0o600 }); };
    child.stdout?.on('data',append); child.stderr?.on('data',append);
    await once(child,'exit'); if (!stopped) await delay(1000);
  }
}
async function main() {
  const command=process.argv[2];
  if (command==='build') {
    preflight(); privateDirectory(); const source=sourceHash(),tag=`vista-verde/local-app:${source.slice(0,24)}`;
    run('docker',['build','--platform','linux/arm64','-f','infra/local.Dockerfile','-t',tag,'.']);
    const info=JSON.parse(run('docker',['image','inspect',tag]))[0]; if (info.Architecture!=='arm64') throw new Error('Image architecture mismatch.');
    writeFileSync(join(local,'image.json'),JSON.stringify({ tag,id:info.Id,source },null,2)+'\n'); console.log(`Compiled ARM64 local image ready: ${tag}`);
  } else if (command==='credentials') {
    if (process.argv[3]!=='--confirmed-create-local-credentials') throw new Error('Action-time confirmation required before creating persistent credentials.');
    privateDirectory(); const values=Object.fromEntries(['database-password','application-password','fixture-key'].map(key => [key,randomBytes(32).toString('hex')]));
    writeFileSync(join(local,'credentials.json'),JSON.stringify(values)+'\n',{ flag:'wx',mode:0o600 }); console.log('Created private local credential inputs; values are not printed.');
  } else if (command==='up') install();
  else if (command==='open') await open();
  else if (command==='forward-worker') await forwardWorker();
  else if (command==='stop') {
    preflight(); assertOwnedWorkload(); const state=forwardState(); if (state) process.kill(state.pid,'SIGTERM');
    kube(['scale',`statefulset/${statefulset}`,'--replicas=0']); console.log('Local app/database stopped; PVC and credentials retained.');
  } else if (command==='restart') {
    preflight(); assertOwnedPod(); kube(['rollout','restart',`statefulset/${statefulset}`]); kube(['rollout','status',`statefulset/${statefulset}`,'--timeout=120s']); await open();
  } else if (command==='backup') { preflight(); console.log(await backupLocal()); }
  else if (command==='restore-test' && process.argv[3]) { preflight(); console.log(JSON.stringify(await restoreLocal(process.argv[3]))); }
  else if (command==='status') {
    preflight(); console.log(kube(['get','pod,pvc','-o','wide'])); console.log(JSON.stringify({ url:'http://127.0.0.1:4318',backupDrive:externalDrive,forwardRunning:Boolean(forwardState()) }));
  } else throw new Error('Use build, credentials, up, open, stop, restart, backup, restore-test or status.');
}
try { await main(); } catch (error) { console.error((error as Error).message); process.exitCode=1; }
