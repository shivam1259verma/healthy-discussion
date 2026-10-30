// Loopback-only synthetic Kainostore Marketplace for local tests. It signs real
// ES256 JWTs; the installed SDK verifies them against the fixture JWKS. Nothing
// here talks to the real platform.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

export const APP_ID = '11111111-1111-4111-8111-111111111111';
export const CLIENT_ID = 'fixture-client';
export const CLIENT_SECRET = 'fixture-secret';

export async function startFixture() {
  const good = await generateKeyPair('ES256');
  const evil = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(good.publicKey)), kid: 'fixture-key', alg: 'ES256', use: 'sig' };

  const state = {
    tokens: new Map(),         // bridgeToken -> options
    consumed: new Set(),
    renewals: new Map(),       // renewalToken -> { session fields }
    renewCalls: 0,
    revokeCalls: 0,
    renewMode: 'ok',           // ok | reject | down
    revokeMode: 'ok',          // ok | fail
    assertionSeconds: 300,
    renewalSeconds: 8 * 3600,
  };

  async function sign(fields, { key = good.privateKey, seconds }) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ ...fields, clientId: CLIENT_ID })
      .setProtectedHeader({ alg: 'ES256', kid: 'fixture-key' })
      .setIssuer('kaino-marketplace')
      .setAudience(`integrated-app:${fields.appId}`)
      .setSubject(fields.appScopedUserId)
      .setIssuedAt(now)
      .setExpirationTime(now + seconds)
      .sign(key);
  }

  async function buildSession(opts, renewalToken, renewalExpiresAt) {
    const fields = {
      appId: opts.appId ?? APP_ID,
      appSlug: 'healthy-discussion',
      appScopedUserId: opts.user,
      entitlementId: `ent-${opts.user}`,
      entitlementStatus: opts.entitlementStatus ?? 'active',
      integrationStatus: opts.integrationStatus ?? 'active',
    };
    const seconds = state.assertionSeconds;
    const exp = new Date(Date.now() + seconds * 1000);
    const sessionAssertion = await sign(fields, { key: opts.badSignature ? evil.privateKey : good.privateKey, seconds });
    return {
      ...fields,
      sessionAssertion,
      issuedAt: new Date().toISOString(),
      assertionExpiresAt: exp.toISOString(),
      renewalToken,
      renewalExpiresAt,
    };
  }

  /** Register a one-time bridge token for a user; returns the token. */
  function issueToken(user, opts = {}) {
    const token = randomBytes(12).toString('hex');
    state.tokens.set(token, { user, ...opts });
    return token;
  }

  const readBody = (req) => new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
  const json = (res, status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/integrations/assertion-jwks') return json(res, 200, { keys: [jwk] });

    const authed = req.headers['x-kaino-client-id'] === CLIENT_ID && req.headers['x-kaino-client-secret'] === CLIENT_SECRET;
    if (!authed) return json(res, 401, {});
    const body = await readBody(req);

    if (url.pathname === '/api/integrations/bridge-session') {
      if (state.consumed.has(body.bridgeToken)) {
        return json(res, 409, { error: 'Bridge token already consumed', replayAction: 'request-new-bridge-token' });
      }
      const opts = state.tokens.get(body.bridgeToken);
      if (!opts) {
        return json(res, 401, { error: 'Invalid or expired bridge token', renewalAction: 'request-new-bridge-token' });
      }
      state.consumed.add(body.bridgeToken);
      const renewalToken = randomBytes(32).toString('hex');
      const renewalExpiresAt = new Date(Date.now() + state.renewalSeconds * 1000).toISOString();
      const session = await buildSession(opts, renewalToken, renewalExpiresAt);
      state.renewals.set(renewalToken, { opts, renewalExpiresAt });
      return json(res, 200, body.renewableSession ? session : { ...session, renewalToken: undefined, renewalExpiresAt: undefined });
    }

    if (url.pathname === '/api/integrations/session-renewal') {
      const record = state.renewals.get(body.renewalToken);
      if (body.action === 'revoke') {
        state.revokeCalls += 1;
        if (state.revokeMode === 'fail') return json(res, 503, {});
        state.renewals.delete(body.renewalToken);
        return json(res, 200, { revoked: true });
      }
      state.renewCalls += 1;
      if (state.renewMode === 'down') return json(res, 503, {});
      if (state.renewMode === 'reject' || !record) return json(res, 401, {});
      await new Promise((r) => setTimeout(r, 25)); // widen the window for concurrent-renewal tests
      return json(res, 200, await buildSession(record.opts, body.renewalToken, record.renewalExpiresAt));
    }

    return json(res, 404, {});
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, state, issueToken, close: () => new Promise((r) => server.close(r)) };
}
