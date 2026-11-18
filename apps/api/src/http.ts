import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { foundationCommandNames } from '../../../packages/contracts/src/operation-names.ts';
import { BASELINE, commandNames, operations } from '../../../packages/contracts/src/index.ts';
import type { Envelope, Operation } from '../../../packages/contracts/src/index.ts';
import { BusinessError, demand } from '../../../packages/domain/src/index.ts';
import { compose } from './composition.ts';
import { productionStorybook,storybookRoute } from './storybook.ts';
import { marketWorkspaceSchema } from '../../../packages/contracts/src/market.ts';
import { ProducerError,PRODUCER_VERSION } from '../../producer-demo/protocol.ts';
import type { ProducerAction } from '../../producer-demo/protocol.ts';
import type { ProducerClient } from '../../producer-demo/requester.ts';

export type DemoPersona = { label: string; token: string };
export type WebOptions = { personas: Record<string, DemoPersona>; port?: number; ready?: () => Promise<boolean>; storybook?:boolean; legacy?:boolean; producer?:ProducerClient };
type Session = { csrf: string; expires: number; persona?: string; token?: string };
const commands = new Set<string>(commandNames);
const reads = new Set(Object.keys(operations).filter(name => !commands.has(name)));
const assets = new Map([
  ['/', ['index.html','text/html; charset=utf-8']],
  ['/app', ['index.html','text/html; charset=utf-8']],
  ['/app/', ['index.html','text/html; charset=utf-8']],
  ['/legacy', ['index.html','text/html; charset=utf-8']],
  ['/legacy/', ['index.html','text/html; charset=utf-8']],
  ['/app.js', ['app.js','text/javascript; charset=utf-8']],
  ['/style.css', ['style.css','text/css; charset=utf-8']]
]);
const secureHeaders = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'cross-origin-resource-policy': 'same-origin'
};
async function json(req: IncomingMessage): Promise<unknown> {
  demand(req.headers['content-type'] === 'application/json','VALIDATION_FAILED');
  const chunks: Buffer[] = []; let size = 0;
  for await (const bytes of req) {
    size += Buffer.byteLength(bytes); demand(size <= 65536,'VALIDATION_FAILED'); chunks.push(bytes);
  }
  try { return JSON.parse(new TextDecoder('utf-8',{ fatal:true }).decode(Buffer.concat(chunks,size))); }
  catch { throw new BusinessError('VALIDATION_FAILED'); }
}
function send(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status,{ ...secureHeaders,'content-type': 'application/json' }); res.end(JSON.stringify(data));
}
function equal(a: string, b: string): boolean {
  const left=Buffer.from(a),right=Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left,right);
}
export async function startHttp(connectionString: string, mode: string, web?: WebOptions) {
  if (web?.port !== undefined && (!Number.isInteger(web.port) || web.port<1024 || web.port>65535)) throw new Error('Invalid local listener port.');
  const { pool,repository,application } = await compose(connectionString,mode);
  let stories:ReturnType<typeof productionStorybook> | undefined;
  // Server-owned mapping is explicitly injected only by isolated fixture setup.
  // The selector exchanges a configured grant; it cannot create operator authority.
  try { if (web?.storybook) stories=productionStorybook();
    if (web) for (const [persona,fixture] of Object.entries(web.personas)) {
    demand(/^[a-z][a-z0-9-]{0,39}$/.test(persona),'VALIDATION_FAILED');
    const context=await repository.authenticate(fixture.token);
    const workspace=await application.execute('getWorkspace',{},context);
    demand(workspace.ok && ['buyer_agent','buyer_human','producer'].includes(workspace.data.role as string),'FORBIDDEN');
  }
  } catch (error) { await pool.end(); throw error; }
  let authority = '';
  const sessions = new Map<string,Session>();
  const cookieName = 'vv_demo_session';
  function session(req: IncomingMessage): { id?: string; value?: Session } {
    const cookies=req.headers.cookie?.split(';').map(v => v.trim()).filter(v => v.startsWith(`${cookieName}=`)) ?? [];
    const id=cookies.length === 1 ? cookies[0]!.slice(cookieName.length+1) : undefined;
    const value=id && /^[A-Za-z0-9_-]{43}$/.test(id) ? sessions.get(id) : undefined;
    if (!value || value.expires <= Date.now()) { if (id) sessions.delete(id); return {}; }
    return { id,value };
  }
  function issue(res: ServerResponse, persona?: string): Session {
    for (const [id,value] of sessions) if (value.expires <= Date.now()) sessions.delete(id);
    demand(sessions.size < 1000,'RETRYABLE_BUSY');
    const id=randomBytes(32).toString('base64url');
    const value: Session={ csrf: randomBytes(32).toString('base64url'),expires: Date.now()+3600000,
      ...(persona ? { persona,token: web!.personas[persona]!.token } : {}) };
    sessions.set(id,value);
    res.setHeader('set-cookie',`${cookieName}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600`);
    return value;
  }
  const describe = (s: Session) => ({ signedIn: Boolean(s.token),csrf: s.csrf,persona: s.persona ?? null,
    producerExchange:Boolean(web?.producer),
    personas: Object.entries(web!.personas).map(([id,p]) => ({ id,label: p.label })) });
  const server = createServer(async (req,res) => {
    try {
      demand(req.socket.remoteAddress === '127.0.0.1' && req.headers.host === authority,'FORBIDDEN');
      demand(!req.headers.origin || req.headers.origin === `http://${authority}`,'FORBIDDEN');
      const url=req.url ?? '';
      // Ignore query parameters for immutable compiled story assets. The exact
      // allowlist still rejects encoded/traversal paths and unrelated files.
      const story=stories?storybookRoute(url,stories):undefined;
      if (story && (story.asset||story.redirect) && ['GET','HEAD'].includes(req.method??'')) {
        demand(!req.headers['sec-fetch-site'] || ['same-origin','none'].includes(req.headers['sec-fetch-site'] as string),'FORBIDDEN');
        if(story.redirect){res.writeHead(308,{...secureHeaders,location:story.redirect});res.end();return;}
        const asset=story.asset!;
        res.writeHead(200,{ ...secureHeaders,'content-type':asset.type,'content-security-policy':asset.policy,'content-length':asset.body.length });
        res.end(req.method==='HEAD'?undefined:asset.body);return;
      }
      if (web && req.method==='GET' && ['/health/live','/health/ready'].includes(url)) {
        let healthy=true;
        if (url==='/health/ready') try { healthy=web.ready ? await web.ready() : true; } catch { healthy=false; }
        send(res,{ healthy,synthetic:true },healthy ? 200 : 503); return;
      }
      if (web?.legacy===false && /^\/legacy(?:\/|\?|$)/.test(url)) throw new BusinessError('FORBIDDEN');
      if (web && assets.has(url) && req.method === 'GET') {
        const [file,type]=assets.get(url)!;
        // Served from the compiled tree only; no arbitrary path or source-directory traversal.
        let body=readFileSync(new URL(import.meta.url.endsWith('.ts') ? `../../../dist/apps/web/${file}` : `../../web/${file}`,import.meta.url));
        if (file==='index.html' && web.legacy===false) body=Buffer.from(body.toString('utf8').replace('<div id="root"></div>','<div id="root" data-legacy-workspace="disabled"></div>'));
        res.writeHead(200,{ ...secureHeaders,'content-type': type }); res.end(body); return;
      }
      if (web && url === '/session') {
        demand(!req.headers['sec-fetch-site'] || ['same-origin','none'].includes(req.headers['sec-fetch-site'] as string),'FORBIDDEN');
        const existing=session(req);
        if (req.method === 'GET') {
          const s=existing.value ?? issue(res);
          if (s.token) await repository.authenticate(s.token);
          send(res,describe(s)); return;
        }
        demand(req.method === 'POST' || req.method === 'DELETE','FORBIDDEN');
        demand(req.headers.origin === `http://${authority}` && existing.value,'FORBIDDEN');
        const csrf=req.headers['x-csrf-token'];
        demand(typeof csrf === 'string' && equal(csrf,existing.value.csrf),'FORBIDDEN');
        let persona: string | undefined;
        if (req.method === 'POST') {
          const body=await json(req);
          demand(body !== null && typeof body === 'object' && !Array.isArray(body)
            && Object.keys(body).length === 1 && 'persona' in body && typeof body.persona === 'string','VALIDATION_FAILED');
          persona=(body as { persona: string }).persona;
          demand(Object.hasOwn(web.personas,persona),'FORBIDDEN');
          await repository.authenticate(web.personas[persona]!.token);
        }
        sessions.delete(existing.id!); send(res,describe(issue(res,persona))); return;
      }
      const producerAction=url.match(/^\/producer-demo\/(read|submit|accept)$/)?.[1] as ProducerAction|undefined;
      const route=url.match(/^\/(queries|commands)\/([A-Za-z]+)$/);
      const operation=route?.[2] as Operation | undefined;
      demand(req.method === 'POST' && (producerAction ? Boolean(web?.producer) : operation &&
        (route![1] === 'queries' ? reads.has(operation) : commands.has(operation))),'FORBIDDEN');
      // An old document may survive rollout and obtain a fresh session. Its
      // legacy retry must never execute against the isolated work store.
      demand(!(web?.legacy===false && route?.[1]==='commands' && (foundationCommandNames as readonly string[]).includes(operation!)),'FORBIDDEN');
      let token: string;
      const browser=session(req).value;
      const bearer=req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if (browser?.token && !req.headers.authorization) {
        demand(req.headers.origin === `http://${authority}`,'FORBIDDEN');
        demand(!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin','FORBIDDEN');
        const csrf=req.headers['x-csrf-token'];
        demand(typeof csrf === 'string' && equal(csrf,browser.csrf),'FORBIDDEN');
        token=browser.token;
      } else {
        // Existing authenticated nonbrowser bearer reads remain supported.
        // Writes require a browser session + Origin + CSRF, never a bearer shortcut.
        demand(bearer,'UNAUTHENTICATED'); demand(!producerAction && route?.[1] === 'queries','FORBIDDEN');
        demand(!req.headers['sec-fetch-site'],'FORBIDDEN'); token=bearer;
      }
      const context=await repository.authenticate(token,randomUUID());
      if(producerAction){
        const result=await application.execute('getMarketWorkspace',{limit:1},context);
        demand(result.ok,'FORBIDDEN');
        const workspace=marketWorkspaceSchema.parse(result.data);
        demand(workspace.permissions.canPostWorkOrder,'FORBIDDEN');
        if(producerAction==='accept')demand(workspace.permissions.canConfirm,'FORBIDDEN');
        send(res,await web!.producer!.call(context.organizationId,producerAction,await json(req)));return;
      }
      const output=await application.execute(operation!,await json(req),context);
      send(res,output,output.ok ? 200 : output.code === 'FORBIDDEN' ? 403 : 400);
    } catch (error) {
      if(error instanceof ProducerError){send(res,{schemaVersion:PRODUCER_VERSION,ok:false,code:error.code,retryable:error.code==='UNAVAILABLE'},error.code==='UNAVAILABLE'?503:error.code==='FORBIDDEN'?403:400);return;}
      const code=error instanceof BusinessError ? error.code : 'INTERNAL_ERROR';
      const output: Envelope={ schemaVersion: BASELINE,ok: false,code,message: code,
        retryable: code === 'RETRYABLE_BUSY',fieldIssues: [] };
      send(res,output,code === 'UNAUTHENTICATED' ? 401 : code === 'FORBIDDEN' ? 403 : 400);
    }
  });
  server.requestTimeout=10000; server.headersTimeout=10000;
  server.listen(web?.port ?? 0,'127.0.0.1'); await once(server,'listening');
  const address=server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback listener failed.');
  authority=`127.0.0.1:${address.port}`;
  return { url: `http://${authority}`,async close() {
    sessions.clear();
    await new Promise<void>(resolve => {
      const deadline=setTimeout(() => server.closeAllConnections(),5000); deadline.unref();
      server.close(() => { clearTimeout(deadline); resolve(); });
    });
    await pool.end();
  } };
}
