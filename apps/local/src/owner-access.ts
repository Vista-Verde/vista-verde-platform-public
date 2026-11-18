import { createServer, request } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { BASELINE, commandNames, operations } from '../../../packages/contracts/src/index.ts';
import { productionStorybook,storybookRoute,STORYBOOK_MOUNT } from '../../api/src/storybook.ts';

// A separate, opt-in boundary for the owner to inspect synthetic fixtures.
// These are trusted deployment constants, never claims or forwarded headers.
export const OWNER_HOST = 'platform.example.invalid';
export const OWNER_ORIGIN = `https://${OWNER_HOST}`;
export const OWNER_ISSUER = 'https://access.example.invalid';
export const OWNER_EMAIL = 'owner@example.invalid';
export const OWNER_COOKIE = '__Host-vv_owner_demo';
export type OwnerAccessConfig = { audience: string; subject?: string };
export type OwnerStorybookConfig = { artifactDigest:string };
type Owner = { subject: string; expires: number };
type Session = { backend: string; subject: string; expires: number };
const commands = new Set<string>(commandNames);
const reads = new Set(Object.keys(operations).filter(name => !commands.has(name)));
const assets = new Set(['/', '/app', '/app/', '/app.js', '/style.css']);
const secureHeaders = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'cross-origin-resource-policy': 'same-origin', 'strict-transport-security': 'max-age=31536000'
};
class Rejected extends Error {
  code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'VALIDATION_FAILED' | 'RETRYABLE_BUSY';
  constructor(code: Rejected['code']) { super(code); this.code = code; }
}
function requireThat(value: unknown, code: Rejected['code'] = 'FORBIDDEN'): asserts value {
  if (!value) throw new Rejected(code);
}
function validateConfig(config: OwnerAccessConfig) {
  requireThat(/^[a-f0-9]{64}$/.test(config.audience) && !/^0{64}$/.test(config.audience), 'VALIDATION_FAILED');
  requireThat(config.subject === undefined || /^[A-Za-z0-9_-]{1,200}$/.test(config.subject), 'VALIDATION_FAILED');
}
export function ownerAccessConfiguration(env: NodeJS.ProcessEnv = process.env): OwnerAccessConfig | undefined {
  if (env.VV_OWNER_ACCESS_ENABLED === undefined || env.VV_OWNER_ACCESS_ENABLED === 'false') return;
  requireThat(env.VV_OWNER_ACCESS_ENABLED === 'true', 'VALIDATION_FAILED');
  const config: OwnerAccessConfig = { audience: env.VV_OWNER_ACCESS_AUDIENCE ?? '',
    ...(env.VV_OWNER_ACCESS_SUBJECT ? { subject: env.VV_OWNER_ACCESS_SUBJECT } : {}) };
  validateConfig(config); return config;
}
export function ownerStorybookConfiguration(env:NodeJS.ProcessEnv=process.env):OwnerStorybookConfig|undefined {
  if (env.VV_OWNER_STORYBOOK === undefined || env.VV_OWNER_STORYBOOK === 'false') return;
  requireThat(env.VV_OWNER_STORYBOOK === 'true' && env.VV_OWNER_ACCESS_ENABLED === 'true','VALIDATION_FAILED');
  const artifactDigest=env.VV_OWNER_STORYBOOK_SHA256 ?? '';
  requireThat(/^[a-f0-9]{64}$/.test(artifactDigest) && !/^0{64}$/.test(artifactDigest),'VALIDATION_FAILED');
  return { artifactDigest };
}
export function ownerVerifier(config: OwnerAccessConfig, keys?: JWTVerifyGetKey) {
  validateConfig(config);
  const resolver = keys ?? createRemoteJWKSet(new URL(`${OWNER_ISSUER}/cdn-cgi/access/certs`), {
    timeoutDuration: 3000, cooldownDuration: 30000, cacheMaxAge: 600000
  }); // jose refuses redirects and only fetches this fixed trusted HTTPS URL.
  return async (assertion: string): Promise<Owner> => {
    requireThat(assertion.length <= 8192 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(assertion), 'UNAUTHENTICATED');
    try {
      const { payload, protectedHeader } = await jwtVerify(assertion, resolver, {
        algorithms: ['RS256'], issuer: OWNER_ISSUER, audience: config.audience,
        requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub', 'email'], maxTokenAge: '4h', clockTolerance: 0
      });
      // RFC 7519 §5.1 makes the format header optional; Cloudflare can omit it.
      // The signed application-token payload type below remains mandatory.
      requireThat((protectedHeader.typ === undefined || protectedHeader.typ === 'JWT') && typeof protectedHeader.kid === 'string'
        && protectedHeader.kid.length > 0 && protectedHeader.kid.length <= 200
        && !protectedHeader.jku && !protectedHeader.jwk && !protectedHeader.x5u, 'UNAUTHENTICATED');
      requireThat(payload.type === 'app' && !payload.common_name && typeof payload.email === 'string'
        && payload.email.toLowerCase() === OWNER_EMAIL && typeof payload.sub === 'string'
        && /^[A-Za-z0-9_-]{1,200}$/.test(payload.sub)
        && (!config.subject || payload.sub === config.subject), 'UNAUTHENTICATED');
      return { subject: payload.sub, expires: payload.exp! * 1000 };
    } catch { throw new Rejected('UNAUTHENTICATED'); }
  };
}
function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const values: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]!.toLowerCase() === name) values.push(req.rawHeaders[i + 1]!);
  }
  requireThat(values.length <= 1); return values[0];
}
function fail(res: ServerResponse, error: unknown) {
  // No assertion, cookie, upstream exception, or identity is reflected or logged.
  const code = error instanceof Rejected ? error.code : 'RETRYABLE_BUSY';
  res.writeHead(code === 'UNAUTHENTICATED' ? 401 : code === 'FORBIDDEN' ? 403 : code === 'RETRYABLE_BUSY' ? 503 : 400,
    { ...secureHeaders, 'content-type': 'application/json' });
  res.end(JSON.stringify({ schemaVersion: BASELINE, ok: false, code, message: code,
    retryable: code === 'RETRYABLE_BUSY', fieldIssues: [] }));
}
async function body(req: IncomingMessage): Promise<Buffer> {
  requireThat(!req.headers['content-length'] || /^\d+$/.test(req.headers['content-length'])
    && Number(req.headers['content-length']) <= 65536, 'VALIDATION_FAILED');
  const parts: Buffer[] = []; let size = 0;
  for await (const part of req) {
    size += part.length; requireThat(size <= 65536, 'VALIDATION_FAILED'); parts.push(part);
  }
  return Buffer.concat(parts, size);
}
async function upstream(url: URL, path: string, method: string, headers: Record<string, string>, bytes: Buffer) {
  return await new Promise<{ status: number; headers: IncomingMessage['headers']; bytes: Buffer }>((resolve, reject) => {
    const outgoing = request(new URL(path, url), { method, headers, agent: false }, response => {
      const parts: Buffer[] = []; let size = 0;
      response.on('data', (part: Buffer) => {
        size += part.length;
        if (size > 2 * 1024 * 1024) response.destroy(new Error('Bounded response exceeded.'));
        else parts.push(part);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, bytes: Buffer.concat(parts, size) }));
    });
    const deadline = setTimeout(() => outgoing.destroy(new Error('Upstream timeout.')), 10000); deadline.unref();
    outgoing.on('close', () => clearTimeout(deadline)); outgoing.on('error', reject); outgoing.end(bytes);
  });
}
export async function startOwnerAccess(upstreamUrl: string, config: OwnerAccessConfig,
  options: { keys?: JWTVerifyGetKey; port?: number; host?: '127.0.0.1' | '0.0.0.0'; storybook?:OwnerStorybookConfig } = {}) {
  const url = new URL(upstreamUrl);
  requireThat(url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) >= 1024
    && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'VALIDATION_FAILED');
  const verify = ownerVerifier(config, options.keys);
  const storybook=options.storybook ? productionStorybook(options.storybook.artifactDigest) : undefined;
  for (const path of storybook?.keys() ?? [])
    requireThat(path === '/' || (!assets.has(path) && path !== '/session' && !/^\/(commands|queries)(\/|$)/.test(path)), 'VALIDATION_FAILED');
  const sessions = new Map<string, Session>();
  const server = createServer(async (req, res) => {
    try {
      requireThat(singleHeader(req, 'host') === OWNER_HOST);
      const assertion = singleHeader(req, 'cf-access-jwt-assertion'); requireThat(assertion, 'UNAUTHENTICATED');
      const owner = await verify(assertion);
      requireThat(!singleHeader(req, 'authorization'));
      const origin = singleHeader(req, 'origin');
      requireThat(origin === undefined || origin === OWNER_ORIGIN);
      const method = req.method ?? ''; const path = req.url ?? '';
      // Exact cached paths only: the query may select a synthetic story, never
      // a file or upstream URL. No request path is used for a filesystem read.
      const story=storybook?storybookRoute(path,storybook):undefined;
      const storybookAsset=story?.asset;
      const safe = method === 'GET' || method === 'HEAD';
      const route = path.match(/^\/(queries|commands)\/([A-Za-z]+)$/);
      requireThat(method === 'GET' && (assets.has(path) || path === '/session')
        || method === 'HEAD' && ['/', '/app', '/app/'].includes(path)
        || safe && Boolean(storybookAsset||story?.redirect)
        || path === '/session' && ['POST', 'DELETE'].includes(method)
        || method === 'POST' && /^\/producer-demo\/(read|submit|accept)$/.test(path)
        || method === 'POST' && route && (route[1] === 'queries' ? reads.has(route[2]!) : commands.has(route[2]!)));
      const site = singleHeader(req, 'sec-fetch-site');
      const mode = singleHeader(req, 'sec-fetch-mode'); const destination = singleHeader(req, 'sec-fetch-dest');
      // Access's login redirect retains cross-site metadata. Only exact top-level
      // entry documents (no query) receive this existing navigation exception,
      // after full owner JWT verification; assets/API/iframes stay closed.
      const navigation = safe && ['/',STORYBOOK_MOUNT,STORYBOOK_MOUNT+'/'].includes(path)
        && mode === 'navigate' && destination === 'document';
      requireThat(!site || (safe ? ['same-origin', 'none'].includes(site) : site === 'same-origin')
        || site === 'cross-site' && navigation);
      if (!safe) requireThat(origin === OWNER_ORIGIN);
      for (const [id, value] of sessions) if (value.expires <= Date.now()) sessions.delete(id);
      const cookies = (singleHeader(req, 'cookie') ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${OWNER_COOKIE}=`));
      requireThat(cookies.length <= 1);
      const id = cookies[0]?.slice(OWNER_COOKIE.length + 1);
      const session = id && /^[A-Za-z0-9_-]{43}$/.test(id) ? sessions.get(id) : undefined;
      if (session) requireThat(session.subject === owner.subject);
      if (!safe) requireThat(session);
      requireThat(sessions.size < 1000 || Boolean(session), 'RETRYABLE_BUSY');
      if(story?.redirect){
        await body(req);res.writeHead(308,{...secureHeaders,location:story.redirect});res.end();return;
      }
      if (storybookAsset) {
        await body(req);
        res.writeHead(200,{ ...secureHeaders,'content-type':storybookAsset.type,
          'content-security-policy':storybookAsset.policy,'content-length':storybookAsset.body.length });
        res.end(method === 'HEAD' ? undefined : storybookAsset.body);return;
      }
      // Header allowlist. In particular, no caller bearer, backend cookie, Access
      // token, email, forwarding header, or arbitrary upstream location is relayed.
      const headers: Record<string, string> = { host: url.host };
      if (origin) headers.origin = url.origin;
      for (const name of ['content-type', 'x-csrf-token', 'sec-fetch-site']) {
        const value = singleHeader(req, name); if (value) headers[name] = value;
      }
      if (session) headers.cookie = session.backend;
      const bytes = await body(req); headers['content-length'] = String(bytes.length);
      // The existing static handler serves GET only; HEAD returns its headers
      // without a body and never enters session or application command routes.
      const result = await upstream(url, ['/app','/app/'].includes(path) ? '/' : path, method === 'HEAD' ? 'GET' : method, headers, bytes);
      const backendCookies = result.headers['set-cookie'];
      let externalCookie: string | undefined;
      if (backendCookies) {
        requireThat(backendCookies.length === 1, 'RETRYABLE_BUSY');
        const backend = backendCookies[0]!.match(/^vv_demo_session=([A-Za-z0-9_-]{43});/);
        requireThat(backend, 'RETRYABLE_BUSY');
        if (id) sessions.delete(id);
        const newId = randomBytes(32).toString('base64url');
        const expires = Math.min(Date.now() + 3600000, owner.expires);
        const age = Math.floor((expires - Date.now()) / 1000); requireThat(age > 0, 'UNAUTHENTICATED');
        sessions.set(newId, { backend: `vv_demo_session=${backend[1]}`, subject: owner.subject, expires });
        externalCookie = `${OWNER_COOKIE}=${newId}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`;
      }
      res.writeHead(result.status, { ...secureHeaders, 'content-type': result.headers['content-type'] ?? 'application/json',
        ...(externalCookie ? { 'set-cookie': externalCookie } : {}) }); res.end(result.bytes);
    } catch (error) { if (!res.headersSent && !res.destroyed) fail(res, error); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.maxHeadersCount = 40;
  server.listen(options.port ?? 4319, options.host ?? '0.0.0.0'); await once(server, 'listening');
  const address = server.address(); requireThat(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, async close() {
    sessions.clear();
    await new Promise<void>(resolve => {
      const deadline = setTimeout(() => server.closeAllConnections(), 5000); deadline.unref();
      server.close(() => { clearTimeout(deadline); resolve(); });
    });
  } };
}
