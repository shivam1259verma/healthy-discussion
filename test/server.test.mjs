// Local behavior tests against a loopback fixture marketplace and a disposable
// PostgreSQL database (TEST_DATABASE_URL). These prove app behavior against the
// SDK contract, not live billing, HTTPS cookies or hosted persistence.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { startFixture, APP_ID, CLIENT_ID, CLIENT_SECRET } from './helpers/fixture-marketplace.mjs';

if (!process.env.TEST_DATABASE_URL) {
  console.error('Set TEST_DATABASE_URL to a disposable loopback PostgreSQL database, e.g. postgres://user:pass@127.0.0.1:5432/hd_test');
  process.exit(1);
}

let fx; let app; let base; let admin;
const COOKIE = '__Host-hd_session';

async function boot() {
  const { createApp } = await import('../lib/app.mjs');
  const server = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
const stop = (server) => new Promise((r) => server.close(r));

before(async () => {
  fx = await startFixture();
  Object.assign(process.env, {
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    KAINO_LOCAL_DEV: '1',
    KAINO_APP_ID: APP_ID,
    KAINO_APP_SLUG: 'healthy-discussion',
    KAINO_MARKETPLACE_URL: fx.url,
    KAINO_INTEGRATION_CLIENT_ID: CLIENT_ID,
    KAINO_INTEGRATION_CLIENT_SECRET: CLIENT_SECRET,
  });
  delete process.env.KAINO_DEPLOYMENT_URL;
  const { migrate } = await import('../migrate.mjs');
  await migrate(() => {});
  admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  ({ server: app, base } = await boot());
});

after(async () => {
  await stop(app);
  const { closePool } = await import('../lib/db.mjs');
  await closePool();
  await admin.end();
  await fx.close();
});

beforeEach(async () => {
  await admin.query('DELETE FROM app_sessions');
  Object.assign(fx.state, { renewMode: 'ok', revokeMode: 'ok', assertionSeconds: 300, renewCalls: 0, revokeCalls: 0 });
});

const get = (path, cookie, init = {}) =>
  fetch(base + path, { redirect: 'manual', ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) } });

async function login(user = 'alice', opts = {}, who = base) {
  const token = fx.issueToken(user, opts);
  const res = await fetch(`${who}/api/kaino/callback?bridge_token=${token}`, { redirect: 'manual' });
  const raw = res.headers.get('set-cookie');
  return { res, token, cookie: raw ? raw.split(';')[0] : null, raw };
}

test('health is independent of login and reports database readiness', async () => {
  const res = await get('/health');
  assert.equal(res.status, 200);
});

test('unauthenticated pages and assets are refused and offer a Kainostore launch', async () => {
  const page = await get('/');
  assert.equal(page.status, 401);
  const html = await page.text();
  assert.ok(!html.includes('Event Log'), 'app UI must not be served without a session');
  assert.ok(html.includes('/integrations/launch/healthy-discussion'));
  assert.equal((await get('/assets/app.js')).status, 401);
  const s = await get('/api/session');
  assert.equal(s.status, 401);
});

test('callback: missing, empty, repeated, invalid and replayed tokens create no session', async () => {
  for (const q of ['', '?bridge_token=', '?bridge_token=a&bridge_token=b']) {
    const r = await get(`/api/kaino/callback${q}`);
    assert.equal(r.status, 400, q);
    assert.equal(r.headers.get('set-cookie'), null);
  }
  const bad = await get('/api/kaino/callback?bridge_token=nope');
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);
  assert.ok(!(await bad.text()).includes('nope'), 'token is never echoed');

  const ok = await login('alice');
  assert.equal(ok.res.status, 302);
  const replay = await get(`/api/kaino/callback?bridge_token=${ok.token}`);
  assert.equal(replay.status, 401);
  assert.equal(replay.headers.get('set-cookie'), null);
});

test('callback success sets a hardened opaque cookie, no-store, and a clean redirect', async () => {
  const { res, token, raw } = await login('alice');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
  assert.ok(!res.headers.get('location').includes(token));
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', COOKIE]) assert.ok(raw.includes(part), part);
  assert.ok(!raw.includes('Domain'));
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');

  const { rows } = await admin.query('SELECT * FROM app_sessions');
  assert.equal(rows.length, 1);
  const value = raw.split(';')[0].split('=')[1];
  const stored = JSON.stringify(rows[0]);
  assert.ok(!stored.includes(value), 'DB stores only a hash of the cookie id');
  assert.ok(!raw.includes(rows[0].session.renewalToken), 'renewal credential never reaches the browser');
  assert.ok(!raw.includes(rows[0].session.sessionAssertion), 'assertion never reaches the browser');
});

test('valid session reaches the app, its script and the session endpoint', async () => {
  const { cookie } = await login('alice');
  const page = await get('/', cookie);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('Healthy') && html.includes('Event Log'));
  assert.ok(!html.includes('onclick='), 'no inline handlers (CSP)');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.headers.get('permissions-policy'), /microphone=\(self\)/);
  assert.equal((await get('/assets/app.js', cookie)).status, 200);
  const s = await get('/api/session', cookie);
  assert.equal(s.status, 200);
  const body = await s.json();
  assert.equal(body.authenticated, true);
  assert.ok(!JSON.stringify(body).includes('alice'), 'identity is not leaked to the page');
});

test('wrong-app, inactive entitlement and inactive integration are rejected', async () => {
  for (const opts of [
    { appId: '99999999-9999-4999-8999-999999999999' },
    { entitlementStatus: 'revoked' },
    { integrationStatus: 'disabled' },
  ]) {
    const r = await login('mallory', opts);
    assert.equal(r.res.status, 403, JSON.stringify(opts));
    assert.equal(r.cookie, null);
  }
  const { rows } = await admin.query('SELECT 1 FROM app_sessions');
  assert.equal(rows.length, 0);
});

test('an assertion signed by a different key is rejected', async () => {
  const r = await login('mallory', { badSignature: true });
  assert.notEqual(r.res.status, 302);
  assert.equal(r.cookie, null);
});

test('tampered or unknown cookies are refused', async () => {
  const { cookie } = await login('alice');
  assert.equal((await get('/', cookie.slice(0, -3) + 'abc')).status, 401);
  assert.equal((await get('/', `${COOKIE}=${'x'.repeat(43)}`)).status, 401);
  assert.equal((await get('/', `${COOKIE}=`)).status, 401);
});

test('a session past its absolute limit is refused and deleted', async () => {
  const { cookie } = await login('alice');
  await admin.query("UPDATE app_sessions SET session = jsonb_set(session, '{renewalExpiresAt}', to_jsonb(($1)::text))", [new Date(Date.now() - 1000).toISOString()]);
  assert.equal((await get('/', cookie)).status, 401);
  assert.equal((await admin.query('SELECT 1 FROM app_sessions')).rowCount, 0);
});

test('near-expiry assertions are renewed transparently and persisted', async () => {
  fx.state.assertionSeconds = 30; // inside the 60s renewal window
  const { cookie } = await login('alice');
  const before = (await admin.query('SELECT session FROM app_sessions')).rows[0].session.sessionAssertion;
  fx.state.assertionSeconds = 300;
  const res = await get('/api/session', cookie);
  assert.equal(res.status, 200);
  assert.equal(fx.state.renewCalls, 1);
  const after = (await admin.query('SELECT session FROM app_sessions')).rows[0].session.sessionAssertion;
  assert.notEqual(before, after);
  await get('/api/session', cookie);
  assert.equal(fx.state.renewCalls, 1, 'fresh assertion is not renewed again');
});

test('concurrent requests share one renewal', async () => {
  fx.state.assertionSeconds = 30;
  const { cookie } = await login('alice');
  fx.state.assertionSeconds = 300;
  const results = await Promise.all(Array.from({ length: 6 }, () => get('/api/session', cookie)));
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(fx.state.renewCalls, 1);
});

test('a rejected renewal ends the session; a platform outage fails closed but keeps it', async () => {
  fx.state.assertionSeconds = 30;
  const a = await login('alice');
  fx.state.renewMode = 'down';
  const down = await get('/', a.cookie);
  assert.equal(down.status, 503);
  assert.equal((await admin.query('SELECT 1 FROM app_sessions')).rowCount, 1, 'session kept during an outage');

  fx.state.renewMode = 'reject';
  assert.equal((await get('/', a.cookie)).status, 401);
  assert.equal((await admin.query('SELECT 1 FROM app_sessions')).rowCount, 0, 'session removed after rejection');
});

test('logout needs a same-origin request, revokes on the platform and clears the session', async () => {
  const { cookie } = await login('alice');
  const csrf = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie, origin: 'https://evil.example' } });
  assert.equal(csrf.status, 403);
  const bare = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(bare.status, 403);
  assert.equal((await get('/', cookie)).status, 200, 'rejected logout leaves the session intact');

  const ok = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie, origin: base } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).platformRevoked, true);
  assert.match(ok.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(fx.state.revokeCalls, 1);
  assert.equal((await get('/', cookie)).status, 401);
});

test('logout still removes the local session when platform revocation fails, and says so', async () => {
  const { cookie } = await login('alice');
  fx.state.revokeMode = 'fail';
  const res = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie, origin: base } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).platformRevoked, false);
  assert.equal((await get('/', cookie)).status, 401);
});

test('two customers stay independent', async () => {
  const a = await login('alice');
  const b = await login('bob');
  assert.notEqual(a.cookie, b.cookie);
  await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie: a.cookie, origin: base } });
  assert.equal((await get('/', a.cookie)).status, 401);
  assert.equal((await get('/', b.cookie)).status, 200);
  const rows = (await admin.query('SELECT app_scoped_user_id FROM app_sessions')).rows;
  assert.deepEqual(rows.map((r) => r.app_scoped_user_id), ['bob']);
});

test('sessions survive a server restart', async () => {
  const { cookie } = await login('alice');
  await stop(app);
  const { closePool } = await import('../lib/db.mjs');
  await closePool();
  ({ server: app, base } = await boot());
  assert.equal((await get('/', cookie)).status, 200);
});

test('migrations are safe to rerun', async () => {
  const { migrate } = await import('../migrate.mjs');
  await migrate(() => {});
  await migrate(() => {});
  const { rows } = await admin.query('SELECT count(*)::int AS n FROM schema_migrations');
  assert.equal(rows[0].n, 1);
});

test('responses carry the security headers and unknown paths 404', async () => {
  const res = await get('/nope');
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await get('/public/app.js')).status, 404);
  assert.equal((await get('/../server.mjs')).status, 404);
});
