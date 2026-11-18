import { createHash,randomUUID } from 'node:crypto';
import { lstatSync,createWriteStream,createReadStream,writeFileSync,readFileSync } from 'node:fs';
import { join,resolve,basename } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { verifiedBackupDirectory,assertOwnedPod,kube,kubectl,namespace,externalDrive } from './local-backup.ts';
import { WORK_DATABASE,WORK_PROFILE } from '../apps/local/src/config.ts';

// The unchanged legacy tool remains bound to vista_verde_local. This companion
// binds snapshot, dump, manifest and restore proofs to the isolated work store.
async function checksum(path: string): Promise<string> {
  const hash=createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex');
}
export type WorkBackupMetadata={ database:typeof WORK_DATABASE;profile:typeof WORK_PROFILE;snapshot:string; business:{ checksum:string;counts:Record<string,number> };grants:unknown[];evidenceFiles:unknown[];synthetic:true };
export async function backupWorkOrders(): Promise<string> {
  const directory=verifiedBackupDirectory(),podUID=assertOwnedPod();
  const name=`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}`;
  const partial=join(directory,`${name}.dump`),manifest=join(directory,`${name}.manifest.json`);
  const session=spawn(kubectl,['--context','orbstack','--namespace',namespace,'exec','-i','vista-verde-local-0','-c','app','--','node','dist/apps/local/src/work-snapshot.js'],{ stdio:['pipe','pipe','pipe'],timeout:130000 });
  session.stderr.resume();
  let metadata:WorkBackupMetadata;
  const sessionExit=once(session,'exit'); const lines=createInterface({ input:session.stdout });
  try {
    const first=await Promise.race([once(lines,'line').then(([line]) => String(line)),sessionExit.then(() => { throw new Error('Snapshot session failed before export.'); })]);
    metadata=JSON.parse(first) as WorkBackupMetadata;
    if (metadata.database!==WORK_DATABASE || metadata.profile!==WORK_PROFILE || !/^[A-Fa-f0-9-]{1,64}$/.test(metadata.snapshot) || metadata.synthetic!==true || metadata.evidenceFiles.length!==0) throw new Error('Unsupported snapshot/evidence manifest.');
    verifiedBackupDirectory();
    const dump=spawn(kubectl,['--context','orbstack','--namespace',namespace,'exec','vista-verde-local-0','-c','postgres','--','sh','-c',`export PGPASSWORD="$(cat /run/vista-verde/database-password)"; exec pg_dump -h 127.0.0.1 -U postgres -d vista_verde_work_orders --format=custom --no-owner --no-acl --exclude-table-data=public.grants --exclude-table-data=public.local_operation_state --snapshot=${metadata.snapshot}`],{ stdio:['ignore','pipe','pipe'],timeout:120000 });
    dump.stderr.resume();
    const exit=once(dump,'exit'); await pipeline(dump.stdout,createWriteStream(partial,{ flags:'wx',mode:0o600,flush:true }));
    if ((await exit)[0]!==0) throw new Error('Database dump failed; incomplete dump is retained without a success manifest.');
    session.stdin.end('finish\n');
    if ((await sessionExit)[0]!==0) throw new Error('Snapshot session failed; no success manifest is written.');
    if (assertOwnedPod()!==podUID) throw new Error('Pod changed during backup.'); verifiedBackupDirectory();
    const digest=await checksum(partial); verifiedBackupDirectory();
    writeFileSync(manifest,JSON.stringify({ format:'vista-verde-work-orders-backup.v1',createdAt:new Date().toISOString(),volumeUUID:externalDrive.uuid,podUID,namespace,dump:basename(partial),sha256:digest,...metadata,snapshot:undefined,credentialsIncluded:false,encrypted:false,offSite:false },null,2)+'\n',{ flag:'wx',mode:0o600,flush:true });
    return manifest;
  } finally { if (!session.stdin.writableEnded) session.stdin.end('finish\n'); await sessionExit; lines.close(); }
}
export async function restoreWorkOrders(manifestPath: string): Promise<unknown> {
  const directory=verifiedBackupDirectory(); assertOwnedPod();
  if (resolve(manifestPath)!==join(directory,basename(manifestPath)) || lstatSync(manifestPath).isSymbolicLink()) throw new Error('Restore manifest must be in the verified backup folder.');
  const metadata=JSON.parse(readFileSync(manifestPath,'utf8')) as WorkBackupMetadata & { format:string;dump:string;sha256:string;volumeUUID:string;credentialsIncluded:boolean };
  if (metadata.database!==WORK_DATABASE || metadata.profile!==WORK_PROFILE || metadata.format!=='vista-verde-work-orders-backup.v1' || metadata.volumeUUID!==externalDrive.uuid || metadata.credentialsIncluded!==false || basename(metadata.dump)!==metadata.dump) throw new Error('Unsupported restore manifest.');
  const path=join(directory,metadata.dump); if (lstatSync(path).isSymbolicLink() || await checksum(path)!==metadata.sha256) throw new Error('Backup checksum mismatch.');
  verifiedBackupDirectory(); const database=`vv_restore_${randomUUID().replaceAll('-','').slice(0,24)}`;
  const prefix=['exec','-i','vista-verde-local-0','-c','postgres','--','sh','-c'];
  kube([...prefix,`export PGPASSWORD="$(cat /run/vista-verde/database-password)"; exec createdb -h 127.0.0.1 -U postgres ${database}`]);
  async function section(name:'pre-data'|'data'|'post-data') {
    const restore=spawn(kubectl,['--context','orbstack','--namespace',namespace,...prefix,`export PGPASSWORD="$(cat /run/vista-verde/database-password)"; exec pg_restore -h 127.0.0.1 -U postgres -d ${database} --section=${name} --no-owner --no-acl --exit-on-error`],{ stdio:['pipe','ignore','pipe'],timeout:120000 });
    restore.stderr.resume();const exit=once(restore,'exit');await pipeline(createReadStream(path),restore.stdin);
    if ((await exit)[0]!==0) throw new Error('Restore failed; the source was untouched and isolated target retained.');
  }
  await section('pre-data');await section('data');
  kube([...prefix,`export PGPASSWORD="$(cat /run/vista-verde/database-password)"; exec psql -h 127.0.0.1 -U postgres -d ${database} -v ON_ERROR_STOP=1 -c 'GRANT CONNECT ON DATABASE ${database} TO vista_verde_app; GRANT USAGE ON SCHEMA public TO vista_verde_app; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO vista_verde_app'`]);
  // Credentials remain excluded. Disabled historical grant rows must exist
  // before PostgreSQL validates the restored approval foreign keys.
  const manifest=JSON.stringify({ database:WORK_DATABASE,profile:WORK_PROFILE,business:metadata.business,grants:metadata.grants });
  kube(['exec','-i','vista-verde-local-0','-c','app','--','node','dist/apps/local/src/work-verify-restore.js',database,'--prepare-authority'],manifest);
  await section('post-data');
  const proof=JSON.parse(kube(['exec','-i','vista-verde-local-0','-c','app','--','node','dist/apps/local/src/work-verify-restore.js',database],manifest)) as unknown;
  verifiedBackupDirectory();
  writeFileSync(join(directory,`${database}.restore-verification.json`),JSON.stringify(proof,null,2)+'\n',{ flag:'wx',mode:0o600,flush:true }); return proof;
}

if (process.argv[1]?.endsWith('/work-order-backup.ts')) {
  try {
    if (process.argv[2]==='backup') console.log(await backupWorkOrders());
    else if (process.argv[2]==='restore' && process.argv[3]) console.log(JSON.stringify(await restoreWorkOrders(process.argv[3])));
    else throw new Error('Use backup or restore with a work-profile manifest path.');
  } catch { console.error('Profile-bound work backup operation failed safely.');process.exitCode=1; }
}
