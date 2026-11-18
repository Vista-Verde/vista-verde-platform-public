import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { localPool } from '../packages/db/src/postgres.ts';

const mode=process.argv[2] ?? 'foundation';
if (!['ui-regression','compact','producer','foundation','market','work','web','storybook','print','demo','owner-integration','owner-storybook'].includes(mode)) throw new Error('Unknown isolated runner.');
const image = 'postgres@sha256:5a65324fe84dc41709ff914e90b07f3e2f577073ed27bf917d4873aca0c9ec51';
const name = `vv-foundation-${randomUUID()}`;
const password = randomBytes(32).toString('hex');
function docker(args: string[], env = process.env): string {
  const run = spawnSync('docker',args,{ env,encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`Docker fixture command failed (${args[0]}). No external database fallback is allowed.`);
  return run.stdout.trim();
}
let created = false;
let child: ReturnType<typeof spawn> | undefined;
const cleanup = () => { if (created) { docker(['rm','-f',name]); created = false; } };
process.once('SIGINT',() => { child?.kill('SIGINT'); cleanup(); process.exit(130); });
process.once('SIGTERM',() => { child?.kill('SIGTERM'); cleanup(); process.exit(143); });
try {
  docker(['image','inspect',image]); // --pull=never: use cached image; no registry or cluster operation.
  docker(['run','--detach','--rm','--pull=never','--name',name,'--label','vista-verde.fixture=foundation',
    '--memory','512m','--cpus','1','--tmpfs','/var/lib/postgresql/data:rw,nosuid,size=256m',
    '--publish','127.0.0.1::5432','--env','POSTGRES_PASSWORD',image],{ ...process.env,POSTGRES_PASSWORD: password });
  created = true;
  const port = docker(['port',name,'5432/tcp']).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error('Database fixture is not loopback-bound.');
  const connectionString = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`;
  const probe = localPool(connectionString);
  try {
    let ready = false;
    for (let i=0; i<100; i++) {
      try { await probe.query('SELECT 1'); ready=true; break; } catch { await setTimeout(100); }
    }
    if (!ready) throw new Error('Temporary PostgreSQL fixture failed to become ready.');
    const version = (await probe.query('SHOW server_version')).rows[0].server_version;
    console.log(`Isolated synthetic PostgreSQL ${version}; pinned cached image, tmpfs, loopback port.`);
  } finally { await probe.end(); }
  const files=mode==='ui-regression'?['tests/foundation/market-browser.test.ts','tests/foundation/persistent-print-browser.test.ts']:mode==='compact'?['tests/foundation/compact-market-browser.test.ts']:mode==='producer'?['tests/foundation/producer-exchange.test.ts','tests/foundation/producer-recovery.test.ts','tests/foundation/producer-exchange-access.test.ts','tests/foundation/producer-exchange-browser.test.ts']:mode === 'owner-storybook' ? ['tests/foundation/owner-access.test.ts','tests/foundation/owner-access-browser.test.ts','tests/foundation/owner-storybook.test.ts','tests/foundation/owner-storybook-browser.test.ts'] : mode === 'owner-integration' ? ['tests/foundation/owner-work-pending.test.ts','tests/foundation/owner-work.test.ts','tests/foundation/owner-work-store.test.ts','tests/foundation/owner-work-browser.test.ts'] :
    mode === 'web' ? ['tests/foundation/browser.test.ts','tests/foundation/market-browser.test.ts','tests/foundation/work-browser.test.ts','tests/foundation/persistent-print-browser.test.ts','tests/foundation/route-demo-browser.test.ts'] :
    mode === 'print' ? ['tests/foundation/print-flow.test.ts','tests/foundation/print-browser.test.ts'] :
    mode === 'storybook' ? ['tests/foundation/storybook-host.test.ts'] : mode === 'market' ? ['tests/foundation/market.test.ts'] :
      mode === 'work' ? ['tests/foundation/work-orders.test.ts','tests/foundation/work-sourcing.test.ts'] :
      ['tests/foundation/postgres.test.ts','tests/foundation/adapters.test.ts','tests/foundation/review.test.ts','tests/foundation/web.test.ts','tests/foundation/market.test.ts','tests/foundation/market-adapters.test.ts','tests/foundation/work-orders.test.ts','tests/foundation/work-sourcing.test.ts'];
  const args=mode === 'demo' ? ['tools/serve-web.ts'] : ['--test','--test-concurrency=1',...files];
  child = spawn(process.execPath,args,
    { stdio: 'inherit',env: { ...process.env,VV_TEST_DATABASE_URL: connectionString } });
  const code = await new Promise<number>((resolve,reject) => { child!.once('error',reject); child!.once('exit',code => resolve(code ?? 1)); });
  process.exitCode = code;
} finally { cleanup(); }
