import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { OWNER_COOKIE, OWNER_EMAIL, OWNER_HOST, OWNER_ISSUER, OWNER_ORIGIN,
  startOwnerAccess } from '../../apps/local/src/owner-access.ts';
import { fixture } from './helpers.ts';
import { web } from './web-helpers.ts';

test('Chromium owner Access redirect uses browser metadata, Secure cookie and real React bootstrap/session/read/reload/logout while cross-site abuse fails', async t => {
  const f = await fixture(t); const api = await web(f); const before = await f.snapshot();
  const pair = await generateKeyPair('RS256'); const audience = 'a'.repeat(64);
  const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'browser-fixture', alg: 'RS256' }] });
  const now = Math.floor(Date.now() / 1000);
  let assertion = await new SignJWT({ iss: OWNER_ISSUER, aud: [audience], iat: now, exp: now + 3600,
    sub: 'browser-owner-fixture', email: OWNER_EMAIL, type: 'app' })
    .setProtectedHeader({ alg: 'RS256', kid: 'browser-fixture' }).sign(pair.privateKey);
  const gateway = await startOwnerAccess(api.url, { audience }, { keys, port: 0, host: '127.0.0.1' });
  f.cleanupWith(() => gateway.close());
  const loginOrigin = 'https://access-login.fixture.invalid', hostileOrigin = 'https://hostile.fixture.invalid';
  const observed: { path: string; method: string; site?: string; mode?: string; destination?: string;
    origin?: string; cookie?: string; status: number }[] = [];
  const directory = mkdtempSync(join(tmpdir(), 'vv-owner-browser-'));
  f.cleanupWith(async () => { rmSync(directory, { recursive: true, force: true }); });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1',
    '-subj', '/CN=synthetic-browser-fixture', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' });
  // Real TLS requests expose Chromium's wire metadata (request interception
  // can omit Sec-Fetch-*). Only fixture certificate errors are ignored. This
  // local edge adds the synthetic assertion, preserving all browser headers.
  const tls = createServer({ key: readFileSync(join(directory, 'key.pem')), cert: readFileSync(join(directory, 'cert.pem')) }, (incoming, response) => {
    const target = new URL(incoming.url!, 'https://' + incoming.headers.host);
    if (target.origin === loginOrigin) {
      if (target.pathname === '/return') { response.writeHead(302, { location: OWNER_ORIGIN + '/#' }); response.end(); }
      else { response.setHeader('content-type', 'text/html'); response.end('<a href="/return">Complete fixture login</a>'); }
      return;
    }
    if (target.origin === hostileOrigin) {
      response.setHeader('content-type', 'text/html'); response.end(`<h1>Hostile fixture</h1>
        <script src="${OWNER_ORIGIN}/app.js"></script><img src="${OWNER_ORIGIN}/style.css">
        <iframe src="${OWNER_ORIGIN}/"></iframe>`); return;
    }
    if (target.origin !== OWNER_ORIGIN) { response.writeHead(404); response.end(); return; }
    const headers = incoming.headers;
    const req = request(gateway.url + target.pathname + target.search, { method: incoming.method,
      headers: { ...headers, 'cf-access-jwt-assertion': assertion } }, upstream => {
      observed.push({ path: target.pathname, method: incoming.method!, site: headers['sec-fetch-site'] as string | undefined,
        mode: headers['sec-fetch-mode'] as string | undefined, destination: headers['sec-fetch-dest'] as string | undefined,
        origin: headers.origin, cookie: headers.cookie, status: upstream.statusCode! });
      response.writeHead(upstream.statusCode!, upstream.headers); upstream.pipe(response);
    }); req.on('error', () => { response.writeHead(503); response.end(); }); incoming.pipe(req);
  });
  tls.listen(0, '127.0.0.1'); await once(tls, 'listening'); const address = tls.address();
  assert.ok(address && typeof address !== 'string');
  f.cleanupWith(() => new Promise<void>(resolve => { tls.closeAllConnections(); tls.close(() => resolve()); }));
  const hosts = [OWNER_HOST, new URL(loginOrigin).hostname, new URL(hostileOrigin).hostname];
  const browser = await chromium.launch({ args: ['--no-proxy-server', '--host-resolver-rules=' +
    [...hosts.map(host => `MAP ${host} 127.0.0.1:${address.port}`), 'MAP * ~NOTFOUND'].join(',')] });
  f.cleanupWith(() => browser.close());
  const context = await browser.newContext({ ignoreHTTPSErrors: true }); const page = await context.newPage(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(loginOrigin); await page.getByRole('link', { name: 'Complete fixture login' }).click();
  await page.getByRole('button', { name:'Buyer human · review & publish',exact:false }).waitFor();
  const navigation = observed.find(value => value.path === '/' && value.status === 200)!;
  assert.deepEqual({ method: navigation.method, site: navigation.site, mode: navigation.mode, destination: navigation.destination },
    { method: 'GET', site: 'cross-site', mode: 'navigate', destination: 'document' });
  for (const path of ['/app.js', '/style.css', '/session']) {
    const loaded = observed.find(value => value.path === path && value.method === 'GET')!;
    assert.equal(loaded.status, 200); assert.equal(loaded.site, 'same-origin');
  }
  const anonymous = (await context.cookies(OWNER_ORIGIN)).find(value => value.name === OWNER_COOKIE)!;
  assert.ok(anonymous.secure && anonymous.httpOnly); assert.equal(anonymous.sameSite, 'Strict');
  assert.equal(anonymous.domain, OWNER_HOST); assert.equal(anonymous.path, '/');
  await page.getByRole('button', { name:'Buyer human · review & publish',exact:false }).click();
  await page.getByRole('navigation', { name: 'Market workspace' }).waitFor();
  await page.locator('#market-app[aria-busy="false"]').waitFor();
  const selected = (await context.cookies(OWNER_ORIGIN)).find(value => value.name === OWNER_COOKIE)!;
  assert.notEqual(selected.value, anonymous.value);
  const login = observed.find(value => value.path === '/session' && value.method === 'POST')!;
  assert.equal(login.status, 200); assert.equal(login.site, 'same-origin'); assert.equal(login.origin, OWNER_ORIGIN);
  assert.ok(login.cookie?.includes(OWNER_COOKIE + '=')); assert.ok(observed.some(value => value.path === '/queries/getMarketWorkspace' && value.status === 200));
  await page.reload(); await page.getByRole('navigation', { name: 'Market workspace' }).waitFor();
  await page.locator('#market-app[aria-busy="false"]').waitFor();
  assert.equal((await context.cookies(OWNER_ORIGIN)).find(value => value.name === OWNER_COOKIE)!.value, selected.value);
  // Browser-generated foreign Origin, cross-site fetch/subresource/frame shapes.
  await page.goto(hostileOrigin);
  await page.evaluate(async origin => {
    await Promise.all(['/session', '/queries/getWorkspace', '/commands/createRequirementDraft'].map(async path => {
      try { await fetch(origin + path, { method: path === '/session' ? 'GET' : 'POST', credentials: 'include',
        ...(path === '/session' ? {} : { headers: { 'content-type': 'text/plain' }, body: '{}' }) }); } catch { /* CORS also denies reading rejection. */ }
    }));
  }, OWNER_ORIGIN);
  for (const path of ['/app.js', '/style.css', '/', '/session', '/queries/getWorkspace', '/commands/createRequirementDraft']) {
    const malicious = observed.find(value => value.path === path && value.site === 'cross-site' && value.status === 403);
    assert.ok(malicious, path + ' must be denied'); assert.ok(!malicious.cookie?.includes(OWNER_COOKIE + '='));
  }
  await page.goto(OWNER_ORIGIN); await page.getByRole('navigation', { name: 'Market workspace' }).waitFor();
  await page.locator('#market-app[aria-busy="false"]').waitFor();
  assert.deepEqual(errors, []);
  // The actual UI logout rotates to an anonymous owner cookie; old session is unusable.
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name:'Buyer human · review & publish',exact:false }).waitFor();
  assert.ok(observed.some(value => value.path === '/session' && value.method === 'DELETE' && value.status === 200));
  assert.notEqual((await context.cookies(OWNER_ORIGIN)).find(value => value.name === OWNER_COOKIE)!.value, selected.value);
  assertion = 'forged';
  await page.goto(loginOrigin);
  const rejection = page.waitForResponse(response => response.url().startsWith(OWNER_ORIGIN + '/') && response.request().isNavigationRequest());
  await page.getByRole('link', { name: 'Complete fixture login' }).click();
  const denied = await rejection; assert.equal(denied.status(), 401);
  assert.equal(observed.at(-1)!.site, 'cross-site'); assert.equal(observed.at(-1)!.destination, 'document');
  assert.doesNotMatch(await page.textContent('body') ?? '', /personas|Buyer|Producer|A shared place/);
  assert.deepEqual(await f.snapshot(), before);
});
