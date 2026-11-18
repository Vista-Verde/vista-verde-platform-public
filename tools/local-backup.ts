import { createHash,randomUUID } from 'node:crypto';
import { lstatSync,realpathSync,statSync,mkdirSync,readFileSync,createWriteStream,createReadStream,writeFileSync } from 'node:fs';
import { join,resolve,basename } from 'node:path';
import { spawn,spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
export const externalDrive={ path:'/Volumes/CONFIGURE_BACKUP_VOLUME',uuid:'00000000-0000-0000-0000-000000000000' };
export const backupFolder='Vista-Verde-Manufacturing-Backups';
export const namespace='vista-verde-manufacturing-local';
export const kubectl='/opt/homebrew/bin/kubectl';
export function validateVolume(info: Record<string,unknown>,expected=externalDrive): void {
  if (info.VolumeUUID!==expected.uuid || info.MountPoint!==expected.path || info.FilesystemType!=='apfs' || info.Internal!==false) throw new Error('Expected external backup volume is not mounted.');
}
export function mountedBackupDirectory(): string {
  const info=spawnSync('diskutil',['info','-plist',externalDrive.path],{ encoding:'utf8' });
  if (info.status!==0) throw new Error('Backup drive unavailable; no mount-point directory will be created.');
  const converted=spawnSync('plutil',['-convert','json','-o','-','-'],{ input:info.stdout,encoding:'utf8' });
  if (converted.status!==0) throw new Error('Backup drive identity unreadable.');
  validateVolume(JSON.parse(converted.stdout) as Record<string,unknown>);
  if (lstatSync(externalDrive.path).isSymbolicLink() || realpathSync(externalDrive.path)!==externalDrive.path || statSync(externalDrive.path).dev===statSync('/Volumes').dev) throw new Error('Backup destination is not the external mount.');
  const directory=join(externalDrive.path,backupFolder); mkdirSync(directory,{ recursive:false }); return directory;
}
// Existing directory support never follows a symlink; every invocation rechecks the mount.
export function verifiedBackupDirectory(): string {
  try { return mountedBackupDirectory(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;
    const directory=join(externalDrive.path,backupFolder);
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink() || realpathSync(directory)!==directory || statSync(directory).dev!==statSync(externalDrive.path).dev) throw new Error('Unsafe backup directory.');
    return directory;
  }
}
export function kube(args: string[],input?: string | Buffer): string {
  const result=spawnSync(kubectl,['--context','orbstack','--namespace',namespace,...args],{ encoding:'utf8',input,maxBuffer:2*1024*1024,timeout:120000 });
  if (result.status!==0) throw new Error(`Local Kubernetes operation failed (${args[0]}).`);
  return result.stdout.trim();
}
export function assertOwnedPod(): string {
  assertOwnedWorkload();
  const pod=JSON.parse(kube(['get','pod','vista-verde-local-0','-o','json'])) as { metadata:{ uid:string; labels?:Record<string,string> }; status:{ phase:string } };
  if (pod.metadata.labels?.['app.kubernetes.io/part-of']!=='vista-verde-local' || pod.status.phase!=='Running') throw new Error('Local app pod is unavailable.');
  return pod.metadata.uid;
}
export function assertOwnedWorkload(): void {
  const ns=JSON.parse(kube(['get','namespace',namespace,'-o','json'])) as { metadata:{ labels?:Record<string,string> } };
  if (ns.metadata.labels?.['app.kubernetes.io/part-of']!=='vista-verde-local') throw new Error('Namespace is not project owned.');
  const workload=JSON.parse(kube(['get','statefulset','vista-verde-local','-o','json'])) as { metadata:{ labels?:Record<string,string> } };
  if (workload.metadata.labels?.['app.kubernetes.io/part-of']!=='vista-verde-local') throw new Error('Local workload is not project owned.');
}
async function checksum(path: string): Promise<string> {
  const hash=createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex');
}
export type BackupMetadata={ snapshot:string; business:{ checksum:string;counts:Record<string,number> };grants:unknown[];evidenceFiles:unknown[];synthetic:true };
export async function backupLocal(): Promise<string> {
  const directory=verifiedBackupDirectory(),podUID=assertOwnedPod();
  const name=`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}`;
  const partial=join(directory,`${name}.dump`),manifest=join(directory,`${name}.manifest.json`);
  const session=spawn(kubectl,['--context','orbstack','--namespace',namespace,'exec','-i','vista-verde-local-0','-c','app','--','node','dist/apps/local/src/snapshot.js'],{ stdio:['pipe','pipe','pipe'],timeout:130000 });
  session.stderr.resume();
  let metadata:BackupMetadata;
  const sessionExit=once(session,'exit'); const lines=createInterface({ input:session.stdout });
  try {
    const first=await Promise.race([once(lines,'line').then(([line]) => String(line)),sessionExit.then(() => { throw new Error('Snapshot session failed before export.'); })]);
    metadata=JSON.parse(first) as BackupMetadata;
    if (!/^[A-Fa-f0-9-]{1,64}$/.test(metadata.snapshot) || metadata.synthetic!==true || metadata.evidenceFiles.length!==0) throw new Error('Unsupported snapshot/evidence manifest.');
    verifiedBackupDirectory();
    const dump=spawn(kubectl,['--context','orbstack','--namespace',namespace,'exec','vista-verde-local-0','-c','postgres','--','sh','-c',`export PGPASSWORD="$(cat /run/vista-verde/database-password)"; exec pg_dump -h 127.0.0.1 -U postgres -d vista_verde_local --format=custom --no-owner --no-acl --exclude-table-data=public.grants --exclude-table-data=public.local_operation_state --snapshot=${metadata.snapshot}`],{ stdio:['ignore','pipe','pipe'],timeout:120000 });
    dump.stderr.resume();
    const exit=once(dump,'exit'); await pipeline(dump.stdout,createWriteStream(partial,{ flags:'wx',mode:0o600,flush:true }));
    if ((await exit)[0]!==0) throw new Error('Database dump failed; incomplete dump is retained without a success manifest.');
    session.stdin.end('finish\n');
    if ((await sessionExit)[0]!==0) throw new Error('Snapshot session failed; no success manifest is written.');
    if (assertOwnedPod()!==podUID) throw new Error('Pod changed during backup.'); verifiedBackupDirectory();
    const digest=await checksum(partial); verifiedBackupDirectory();
    writeFileSync(manifest,JSON.stringify({ format:'vista-verde-local-backup.v1',createdAt:new Date().toISOString(),volumeUUID:externalDrive.uuid,podUID,namespace,dump:basename(partial),sha256:digest,...metadata,snapshot:undefined,credentialsIncluded:false,encrypted:false,offSite:false },null,2)+'\n',{ flag:'wx',mode:0o600,flush:true });
    return manifest;
  } finally { if (!session.stdin.writableEnded) session.stdin.end('finish\n'); await sessionExit; lines.close(); }
}
export async function restoreLocal(manifestPath: string): Promise<unknown> {
  const directory=verifiedBackupDirectory(); assertOwnedPod();
  if (resolve(manifestPath)!==join(directory,basename(manifestPath)) || lstatSync(manifestPath).isSymbolicLink()) throw new Error('Restore manifest must be in the verified backup folder.');
  const metadata=JSON.parse(readFileSync(manifestPath,'utf8')) as BackupMetadata & { format:string;dump:string;sha256:string;volumeUUID:string;credentialsIncluded:boolean };
  if (metadata.format!=='vista-verde-local-backup.v1' || metadata.volumeUUID!==externalDrive.uuid || metadata.credentialsIncluded!==false || basename(metadata.dump)!==metadata.dump) throw new Error('Unsupported restore manifest.');
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
  const manifest=JSON.stringify({ business:metadata.business,grants:metadata.grants });
  kube(['exec','-i','vista-verde-local-0','-c','app','--','node','dist/apps/local/src/verify-restore.js',database,'--prepare-authority'],manifest);
  await section('post-data');
  const proof=JSON.parse(kube(['exec','-i','vista-verde-local-0','-c','app','--','node','dist/apps/local/src/verify-restore.js',database],manifest)) as unknown;
  verifiedBackupDirectory();
  writeFileSync(join(directory,`${database}.restore-verification.json`),JSON.stringify(proof,null,2)+'\n',{ flag:'wx',mode:0o600,flush:true }); return proof;
}
