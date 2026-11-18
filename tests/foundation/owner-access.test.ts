import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { request, createServer } from 'node:http';
import type { OutgoingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import { OWNER_COOKIE, OWNER_EMAIL, OWNER_HOST, OWNER_ISSUER, OWNER_ORIGIN,
  ownerAccessConfiguration, ownerVerifier, startOwnerAccess } from '../../apps/local/src/owner-access.ts';
import { draft, publication, purchase } from '../../packages/db/src/fixtures.ts';
import { fixture, ok, failure } from './helpers.ts';
import { browserSession, web } from './web-helpers.ts';
import { envelope } from '../../packages/contracts/src/index.ts';
import type { Operation } from '../../packages/contracts/src/index.ts';

const config = { audience: 'a'.repeat(64) };
const pair = await generateKeyPair('RS256');
const publicJwk = { ...await exportJWK(pair.publicKey), kid: 'fixture-rsa', alg: 'RS256', use: 'sig' };
const keys = createLocalJWKSet({ keys: [publicJwk] });
async function signed(changes: JWTPayload = {}, header: Record<string, unknown> = {}, signingKey = pair.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: OWNER_ISSUER, aud: [config.audience], iat: now, exp: now + 3600,
    sub: 'owner-fixture-subject', email: OWNER_EMAIL, type: 'app', ...changes })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture-rsa', typ: 'JWT', ...header }).sign(signingKey);
}
async function call(url: string, path: string, method = 'GET', headers: OutgoingHttpHeaders = {}, input?: unknown) {
  const bytes = input === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(input));
  const presentHeaders = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));
  return await new Promise<{ status: number; headers: OutgoingHttpHeaders; text: string }>((resolve, reject) => {
    const req = request(`${url}${path}`, { method, headers: { host: OWNER_HOST, ...presentHeaders,
      ...(input !== undefined ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}) } }, response => {
      const parts: Buffer[] = []; response.on('data', (part: Buffer) => parts.push(part)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, text: Buffer.concat(parts).toString('utf8') }));
    }); req.on('error', reject); req.end(bytes);
  });
}
const data = (result: Awaited<ReturnType<typeof call>>) => JSON.parse(result.text) as Record<string, unknown>;
function cookie(result: Awaited<ReturnType<typeof call>>) {
  const value = (result.headers['set-cookie'] as string[])[0]!;
  assert.match(value, new RegExp(`^${OWNER_COOKIE}=[A-Za-z0-9_-]{43};`));
  assert.match(value, /; Secure; HttpOnly; SameSite=Strict;/); assert.doesNotMatch(value, /Domain=|vv_demo_session/);
  assert.ok(Number(value.match(/Max-Age=(\d+)/)![1]) <= 3600); return value.split(';')[0]!;
}
async function setup(t: TestContext) {
  const f = await fixture(t); const api = await web(f);
  const gateway = await startOwnerAccess(api.url, config, { keys, port: 0, host: '127.0.0.1' });
  f.cleanupWith(() => gateway.close()); const assertion = await signed({}, { typ: undefined });
  const ownerHeaders = { 'cf-access-jwt-assertion': assertion };
  const login = async (persona: string) => {
    const boot = await call(gateway.url, '/session', 'GET', ownerHeaders); assert.equal(boot.status, 200);
    const anonymousCookie = cookie(boot);
    const signedIn = await call(gateway.url, '/session', 'POST', { ...ownerHeaders, cookie: anonymousCookie,
      origin: OWNER_ORIGIN, 'sec-fetch-site': 'same-origin', 'x-csrf-token': String(data(boot).csrf) }, { persona });
    assert.equal(signedIn.status, 200); const value = cookie(signedIn); assert.notEqual(value, anonymousCookie);
    const headers = { ...ownerHeaders, cookie: value, origin: OWNER_ORIGIN,
      'sec-fetch-site': 'same-origin', 'x-csrf-token': String(data(signedIn).csrf) };
    return { headers, anonymousCookie, call: async (operation: Operation, input: unknown, overrides: OutgoingHttpHeaders = {}) => {
      const command = ['createRequirementDraft', 'publishRequirement', 'purchaseSlot', 'withdrawUnpurchasedSlot', 'processExpiredSlot'].includes(operation);
      const result = await call(gateway.url, `/${command ? 'commands' : 'queries'}/${operation}`, 'POST', { ...headers, ...overrides }, input);
      return { ...result, receipt: envelope.parse(data(result)) };
    } };
  };
  return { f, api, gateway, ownerHeaders, login };
}

test('owner ingress is disabled by default and refuses missing/placeholder AUD and unsafe upstream configuration', async () => {
  assert.equal(ownerAccessConfiguration({}), undefined); assert.equal(ownerAccessConfiguration({ VV_OWNER_ACCESS_ENABLED: 'false' }), undefined);
  for (const audience of ['', 'NEW_APP_AUD', '0'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)])
    assert.throws(() => ownerAccessConfiguration({ VV_OWNER_ACCESS_ENABLED: 'true', VV_OWNER_ACCESS_AUDIENCE: audience }));
  assert.throws(() => ownerAccessConfiguration({ VV_OWNER_ACCESS_ENABLED: 'yes', VV_OWNER_ACCESS_AUDIENCE: config.audience }));
  assert.deepEqual(ownerAccessConfiguration({ VV_OWNER_ACCESS_ENABLED: 'true', VV_OWNER_ACCESS_AUDIENCE: config.audience }), config);
  for (const url of ['https://127.0.0.1:4318', 'http://localhost:4318', 'http://hostile.invalid:4318', 'http://127.0.0.1:80',
    'http://user:password@127.0.0.1:4318', 'http://127.0.0.1:4318/path', 'http://127.0.0.1:4318/?url=http://hostile.invalid'])
    await assert.rejects(() => startOwnerAccess(url, config, { keys }));
});

test('real RSA verification requires application issuer/AUD/expiry/age/human email/subject and rejects forged or alternate key selectors', async () => {
  const verify = ownerVerifier(config, keys); const valid = await signed(); assert.equal((await verify(valid)).subject, 'owner-fixture-subject');
  const now = Math.floor(Date.now() / 1000);
  for (const header of [{ typ: 'JWT' }, { typ: undefined }]) {
    for (const changes of [
      { iss: 'https://hostile.invalid' }, { aud: ['b'.repeat(64)] }, { exp: now - 1 }, { nbf: now + 60 },
      { iat: now - 14401 }, { iat: now + 60 }, { exp: undefined }, { iat: undefined }, { sub: undefined }, { sub: '' },
      { email: undefined }, { email: 'attacker@example.invalid' }, { email: 'owner@example.invalid.attacker.invalid' },
      { type: 'org' }, { type: undefined }, { common_name: 'service-token', sub: '' }
    ]) await assert.rejects(() => signed(changes, header).then(verify), /UNAUTHENTICATED/);
    for (const alternate of [{ kid: 'unknown-key' }, { typ: 'OTHER' }, { jku: 'https://hostile.invalid/jwks' },
      { jwk: publicJwk }, { x5u: 'https://hostile.invalid/cert' }])
      await assert.rejects(() => signed({}, { ...header, ...alternate }).then(verify), /UNAUTHENTICATED/);
    const rogue = await generateKeyPair('RS256'); await assert.rejects(() => signed({}, header, rogue.privateKey).then(verify), /UNAUTHENTICATED/);
    const none = `${valid.split('.')[0]}.${valid.split('.')[1]}.forged`; await assert.rejects(() => verify(none), /UNAUTHENTICATED/);
    await assert.rejects(() => verify('x'.repeat(8193)), /UNAUTHENTICATED/);
    const unavailable: JWTVerifyGetKey = async () => { throw new Error('Fixture key outage'); };
    await assert.rejects(() => ownerVerifier(config, unavailable)(valid), /UNAUTHENTICATED/);
    await assert.rejects(() => ownerVerifier({ ...config, subject: 'different-subject' }, keys)(valid), /UNAUTHENTICATED/);
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', ...header })).toString('base64url')}.${valid.split('.')[1]}.`;
    await assert.rejects(() => verify(unsigned), /UNAUTHENTICATED/);
  }
});

test('optional typ accepts absent or explicit JWT, rejects other explicit values and never substitutes for signed payload type', async () => {
  const verify = ownerVerifier(config, keys);
  for (const header of [{ typ: undefined }, { typ: 'JWT' }]) {
    const token = await signed({}, header); const decoded = decodeProtectedHeader(token);
    assert.equal(Object.hasOwn(decoded, 'typ'), header.typ !== undefined);
    assert.equal((await verify(token)).subject, 'owner-fixture-subject');
    for (const type of [undefined, 'org', 'service']) await assert.rejects(() => signed({ type }, header).then(verify), /UNAUTHENTICATED/);
  }
  for (const typ of ['OTHER', 'at+jwt', 'application/at+jwt', '', null, 42])
    await assert.rejects(() => signed({}, { typ }).then(verify), /UNAUTHENTICATED/);
});

test('non-RS256 algorithms fail before key resolution with fully valid owner claims and either typ shape', async () => {
  const rsa = await generateKeyPair('RS512'); const hmac = new Uint8Array(32);
  for (const typ of [undefined, 'JWT']) for (const alg of ['RS512', 'HS256']) {
    const token = await new SignJWT(decodeJwt(await signed())).setProtectedHeader({ alg, kid: 'fixture-other-alg', typ })
      .sign(alg === 'RS512' ? rsa.privateKey : hmac);
    let lookups = 0;
    const otherwiseValidKey: JWTVerifyGetKey = async () => { lookups++; return alg === 'RS512' ? rsa.publicKey : hmac; };
    await assert.rejects(() => ownerVerifier(config, otherwiseValidKey)(token), /UNAUTHENTICATED/);
    assert.equal(lookups, 0);
  }
});

test('real HTTP owner session accepts absent and explicit JWT headers but rejects inappropriate explicit typ without selector disclosure', async t => {
  const { f, gateway } = await setup(t); const before = await f.snapshot();
  for (const typ of [undefined, 'JWT']) {
    const assertion = await signed({}, { typ });
    assert.equal(Object.hasOwn(decodeProtectedHeader(assertion), 'typ'), typ !== undefined);
    const boot = await call(gateway.url, '/session', 'GET', { 'cf-access-jwt-assertion': assertion }); assert.equal(boot.status, 200);
    const remoteCookie = cookie(boot);
    const result = await call(gateway.url, '/session', 'POST', { 'cf-access-jwt-assertion': assertion,
      cookie: remoteCookie, origin: OWNER_ORIGIN, 'x-csrf-token': String(data(boot).csrf) }, { persona: 'buyer' });
    assert.equal(result.status, 200); assert.equal(data(result).signedIn, true); cookie(result);
  }
  for (const typ of ['OTHER', 'at+jwt', '', null, 42]) {
    const result = await call(gateway.url, '/session', 'GET', { 'cf-access-jwt-assertion': await signed({}, { typ }) });
    assert.equal(result.status, 401); assert.doesNotMatch(result.text, /personas|Buyer|Producer/);
  }
  assert.deepEqual(await f.snapshot(), before);
});

test('unauthorized, duplicate, wrong-owner and expired assertions cannot serve any UI, disclose personas or mutate data', async t => {
  const { f, gateway, ownerHeaders } = await setup(t); const before = await f.snapshot();
  for (const [path, method, input] of [['/', 'GET'], ['/app.js', 'GET'], ['/style.css', 'GET'], ['/session', 'GET'],
    ['/session', 'POST', { persona: 'buyer' }], ['/queries/getWorkspace', 'POST', {}],
    ['/commands/createRequirementDraft', 'POST', draft('blocked')]] as const) {
    for (const assertion of [undefined, 'forged', await signed({ exp: Math.floor(Date.now() / 1000) - 1 }), await signed({ email: 'other@example.invalid' })]) {
      const result = await call(gateway.url, path, method, assertion ? { 'cf-access-jwt-assertion': assertion } : {}, input);
      assert.equal(result.status, 401); assert.equal(data(result).code, 'UNAUTHENTICATED'); assert.doesNotMatch(result.text, /personas|Buyer|Producer/);
    }
  }
  assert.equal((await call(gateway.url, '/session', 'GET', { ...ownerHeaders, 'cf-access-jwt-assertion': [ownerHeaders['cf-access-jwt-assertion'], ownerHeaders['cf-access-jwt-assertion']] })).status, 403);
  assert.equal((await call(gateway.url, '/session', 'GET', { 'cf-access-authenticated-user-email': OWNER_EMAIL, 'x-forwarded-host': OWNER_HOST })).status, 401);
  for (const path of ['/health/live', '/health/ready', '/../package.json', '/session?persona=buyer', '/commands/unknown'])
    assert.equal((await call(gateway.url, path, 'GET', ownerHeaders)).status, 403);
  assert.deepEqual(await f.snapshot(), before);
});

test('owner boundary enforces public Host/Origin/Fetch Metadata and existing CSRF, with no forwarded-header or bearer bypass', async t => {
  const { f, gateway, ownerHeaders, login } = await setup(t); await f.publish('protected');
  const actor = await login('producer-a'); const before = await f.snapshot();
  for (const headers of [
    { host: '127.0.0.1:4319' }, { host: `${OWNER_HOST}:443` }, { host: 'rebound.invalid', 'x-forwarded-host': OWNER_HOST },
    { origin: 'https://hostile.invalid' }, { origin: '' }, { origin: undefined },
    { origin: 'http://platform.example.invalid', 'x-forwarded-proto': 'https' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'none' },
    { 'x-csrf-token': 'forged' }, { 'x-csrf-token': undefined }, { authorization: `Bearer ${f.token('producer-a')}` }
  ]) {
    const result = await actor.call('purchaseSlot', purchase('protected'), headers); assert.equal(result.status, 403); failure(result.receipt, 'FORBIDDEN');
  }
  assert.equal((await call(gateway.url, '/', 'GET', { ...ownerHeaders, origin: 'https://hostile.invalid' })).status, 403);
  assert.equal((await call(gateway.url, '/', 'GET', { ...ownerHeaders, 'sec-fetch-site': 'cross-site' })).status, 403);
  const tooLarge = await actor.call('purchaseSlot', { padding: 'x'.repeat(65537) }); assert.equal(tooLarge.status, 400);
  assert.deepEqual(await f.snapshot(), before);
});

test('only authenticated safe root document navigation can cross sites; assets, sessions, fetches and commands stay closed', async t => {
  const { f, gateway, ownerHeaders, login } = await setup(t); const actor = await login('buyer');
  const before = await f.snapshot();
  const navigation = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  for (const method of ['GET', 'HEAD']) {
    const response = await call(gateway.url, '/', method, { ...ownerHeaders, ...navigation });
    assert.equal(response.status, 200); assert.match(String(response.headers['content-type']), /text\/html/);
    assert.equal(response.headers['set-cookie'], undefined);
    if (method === 'HEAD') assert.equal(response.text, ''); else assert.match(response.text, /id="root"/);
    for (const assertion of [undefined, 'forged', await signed({ email: 'wrong@example.invalid' }),
      await signed({ exp: Math.floor(Date.now() / 1000) - 1 })]) {
      const denied = await call(gateway.url, '/', method, { ...navigation, 'cf-access-jwt-assertion': assertion });
      assert.equal(denied.status, 401); assert.equal(denied.headers['set-cookie'], undefined);
      assert.doesNotMatch(denied.text, /personas|Buyer|Producer|id="root"/);
    }
  }
  for (const overrides of [
    { 'sec-fetch-mode': 'cors' }, { 'sec-fetch-mode': 'no-cors' }, { 'sec-fetch-mode': undefined },
    { 'sec-fetch-dest': 'empty' }, { 'sec-fetch-dest': 'iframe' }, { 'sec-fetch-dest': 'object' },
    { 'sec-fetch-dest': 'embed' }, { 'sec-fetch-dest': 'image' }, { 'sec-fetch-dest': undefined },
    { 'sec-fetch-site': 'same-site' }, { origin: 'https://hostile.invalid' }, { origin: 'null' },
    { host: 'hostile.invalid', 'x-forwarded-host': OWNER_HOST },
    { 'sec-fetch-mode': ['navigate', 'navigate'] }, { 'sec-fetch-dest': ['document', 'document'] }
  ]) assert.equal((await call(gateway.url, '/', 'GET', { ...ownerHeaders, ...navigation, ...overrides })).status, 403);
  for (const [path, method, input] of [
    ['/app.js', 'GET'], ['/style.css', 'GET'], ['/session', 'GET'], ['/session', 'HEAD'],
    ['/?persona=buyer', 'GET'], ['/queries/getWorkspace', 'GET'], ['/session', 'POST', { persona: 'buyer' }],
    ['/session', 'DELETE'], ['/queries/getWorkspace', 'POST', {}],
    ['/commands/createRequirementDraft', 'POST', draft('cross-site-blocked')], ['/', 'POST', {}]
  ] as const) {
    const denied = await call(gateway.url, path, method, { ...actor.headers, ...navigation }, input);
    assert.equal(denied.status, 403); assert.equal(denied.headers['set-cookie'], undefined);
  }
  assert.equal((await actor.call('getWorkspace', {})).status, 200);
  assert.deepEqual(await f.snapshot(), before);
});

test('owner cookies rotate, bind subject, cap token lifetime and cannot import localhost sessions or select operator authority', async t => {
  const { f, api, gateway, ownerHeaders, login } = await setup(t); const actor = await login('buyer'); const before = await f.snapshot();
  const subjectMismatch = await call(gateway.url, '/session', 'GET', { ...actor.headers,
    'cf-access-jwt-assertion': await signed({ sub: 'different-owner-subject' }) }); assert.equal(subjectMismatch.status, 403);
  assert.equal((await actor.call('getWorkspace', {}, { 'cf-access-jwt-assertion': await signed({ exp: Math.floor(Date.now() / 1000) - 1 }) })).status, 401);
  const local = await browserSession(api.url, 'buyer');
  assert.equal((await actor.call('getWorkspace', {}, { cookie: local.cookie })).status, 403);
  assert.equal((await actor.call('getWorkspace', {}, { cookie: actor.anonymousCookie })).status, 403);
  assert.equal((await actor.call('getWorkspace', {}, { cookie: `${actor.headers.cookie}; ${actor.headers.cookie}` })).status, 403);
  assert.equal((await call(gateway.url, '/session', 'POST', actor.headers, { persona: 'operator' })).status, 403);
  const loggedOut = await call(gateway.url, '/session', 'DELETE', actor.headers); assert.equal(loggedOut.status, 200); cookie(loggedOut);
  assert.equal((await actor.call('getWorkspace', {})).status, 403);
  const brief = await call(gateway.url, '/session', 'GET', { ...ownerHeaders,
    'cf-access-jwt-assertion': await signed({ exp: Math.floor(Date.now() / 1000) + 30 }) }); cookie(brief);
  assert.ok(Number((brief.headers['set-cookie'] as string[])[0]!.match(/Max-Age=(\d+)/)![1]) <= 30);
  assert.deepEqual(await f.snapshot(), before);
});

test('authorized owner can use the React assets and synthetic selectors; publication and last-slot race use the same atomic service and durable replay', async t => {
  const { f, gateway, ownerHeaders, login } = await setup(t);
  for (const path of ['/', '/app.js', '/style.css']) {
    const result = await call(gateway.url, path, 'GET', ownerHeaders); assert.equal(result.status, 200);
    assert.equal(result.headers['cache-control'], 'no-store'); assert.match(String(result.headers['content-security-policy']), /frame-ancestors 'none'/);
  }
  const agent = await login('buyer-agent'); const buyer = await login('buyer');
  const created = ok((await agent.call('createRequirementDraft', draft('owner-demand'))).receipt);
  ok((await buyer.call('publishRequirement', publication(created.recordIds.requirementId!, 'owner-last'))).receipt);
  assert.equal((await f.pool.query("SELECT reserved FROM accounts WHERE id='buyer-funds'")).rows[0].reserved, '6000');
  const a = await login('producer-a'), b = await login('producer-b');
  const results = await Promise.all([a.call('purchaseSlot', purchase('owner-last')), b.call('purchaseSlot', purchase('owner-last'))]);
  assert.equal(results.filter(r => r.receipt.ok).length, 1); failure(results.find(r => !r.receipt.ok)!.receipt, 'SLOT_UNAVAILABLE');
  const winner = results[0]!.receipt.ok ? a : b;
  const retries = await Promise.all([winner.call('purchaseSlot', purchase('owner-last')), winner.call('purchaseSlot', purchase('owner-last'))]);
  assert.deepEqual(retries[0]!.receipt, retries[1]!.receipt); assert.deepEqual(retries[0]!.receipt, results.find(r => r.receipt.ok)!.receipt);
  assert.equal((await f.pool.query('SELECT count(*) FROM commitments')).rows[0].count, '1');
  assert.equal((await f.pool.query('SELECT count(*) FROM journal_entries')).rows[0].count, '2');
  await f.pool.query('UPDATE grants SET revoked=true WHERE id=$1', [f.context('buyer').grantId]);
  assert.equal((await buyer.call('getWorkspace', {})).status, 401); await f.reconcile();
});

test('local HTTP behavior remains protected and independent of Access', async t => {
  const { f, api } = await setup(t); const local = await browserSession(api.url, 'buyer');
  assert.equal((await fetch(api.url)).status, 200); assert.equal((await local.call('getWorkspace', {})).status, 200);
  assert.equal((await local.call('getWorkspace', {}, { host: OWNER_HOST })).status, 403);
  assert.equal((await local.call('getWorkspace', {}, { origin: OWNER_ORIGIN })).status, 403);
  assert.equal((await local.call('getWorkspace', {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await local.call('getWorkspace', {}, { 'x-csrf-token': 'forged' })).status, 403); await f.reconcile();
});

test('gateway strips owner/forwarding/backend headers and fails closed on unavailable or oversized upstream without reflecting secrets', async t => {
  let seen: OutgoingHttpHeaders | undefined; let received = 0;
  const server = createServer((req, res) => {
    seen = req.headers; received++;
    if (req.url === '/app.js') { res.end(Buffer.alloc(2 * 1024 * 1024 + 1)); return; }
    res.setHeader('content-type', 'text/html'); res.end('synthetic probe');
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const gateway = await startOwnerAccess(`http://127.0.0.1:${address.port}`, config, { keys, port: 0, host: '127.0.0.1' });
  t.after(() => gateway.close()); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const result = await call(gateway.url, '/', 'GET', { 'cf-access-jwt-assertion': await signed(),
    'cf-access-authenticated-user-email': OWNER_EMAIL, 'x-forwarded-host': 'hostile.invalid', 'x-forwarded-proto': 'http',
    cookie: 'vv_demo_session=attacker; CF_Authorization=fixture' }); assert.equal(result.status, 200);
  assert.equal(seen?.host, `127.0.0.1:${address.port}`); assert.equal(seen?.cookie, undefined);
  for (const header of ['cf-access-jwt-assertion', 'cf-access-authenticated-user-email', 'x-forwarded-host', 'x-forwarded-proto']) assert.equal(seen?.[header], undefined);
  assert.equal((await call(gateway.url, '/', 'GET')).status, 401); assert.equal(received, 1);
  const large = await call(gateway.url, '/app.js', 'GET', { 'cf-access-jwt-assertion': await signed() }); assert.equal(large.status, 503); assert.equal(data(large).retryable, true);
  await new Promise<void>(resolve => server.close(() => resolve()));
  const unavailable = await call(gateway.url, '/', 'GET', { 'cf-access-jwt-assertion': await signed() }); assert.equal(unavailable.status, 503);
  assert.doesNotMatch(unavailable.text, /ECONNREFUSED|fixture|subject|token/);
});
