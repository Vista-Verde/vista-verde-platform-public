import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Reuse the exact inspected legacy compiled backup implementation. It has its
// own fixed old-store configuration and never starts an HTTP server.
export async function legacyBackupEntry(name:'snapshot'|'verify-restore',args:string[]=[]):Promise<void> {
  const prefix=import.meta.url.endsWith('.ts') ? '../../../':'../../../../';
  const path=fileURLToPath(new URL(`${prefix}legacy-dist/apps/local/src/${name}.js`,import.meta.url));
  const child=spawn(process.execPath,[path,...args],{ stdio:'inherit' });
  const interrupt=() => child.kill('SIGTERM');process.once('SIGTERM',interrupt);process.once('SIGINT',interrupt);
  try { process.exitCode=await new Promise<number>((resolve,reject) => { child.once('error',reject);child.once('exit',code => resolve(code ?? 1)); }); }
  finally { process.removeListener('SIGTERM',interrupt);process.removeListener('SIGINT',interrupt); }
}
