import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KainoSdkError } from '@kainostore/sdk/server';
import { getConfig, launchUrl } from './config.mjs';
import { getKaino } from './kaino.mjs';
import { getPool } from './db.mjs';
import { authenticate, sessionIdFrom } from './auth.mjs';
import {
  clearCookie, createSession, deleteSession, getSession, sessionCookie,
} from './sessions.mjs';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  // The page needs the microphone for itself only.
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; "
    + "img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function messagePage(res, status, title, message, { launch = true, headers = {} } = {}) {
  const url = launch ? launchUrl() : null;
  const link = url ? `<p><a href="${esc(url)}">Launch Healthy Discussion from Kainostore</a></p>` : '';
  send(res, status, `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Healthy Discussion</title>
<style>body{background:#0d1117;color:#e6edf3;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}
main{max-width:420px;text-align:center}h1{font-size:1.5rem;margin:0 0 8px}p{color:#7d8590;line-height:1.5}a{color:#58a6ff}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p>${link}</main></body></html>`,
  { 'Content-Type': 'text/html; charset=utf-8', ...headers });
}

const files = new Map();
async function readPublic(name) {
  if (!files.has(name)) files.set(name, await readFile(path.join(publicDir, name)));
  return files.get(name);
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] === 'same-origin';
  try {
    const host = new URL(origin).host;
    if (host === req.headers.host) return true;
    const dep = getConfig().deploymentUrl;
    return Boolean(dep) && new URL(dep).host === host;
  } catch {
    return false;
  }
}

async function health(res) {
  try {
    await getPool().query('SELECT 1');
    send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8' });
  } catch {
    send(res, 503, 'database unavailable', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
}

async function callback(req, res, url) {
  const headers = { 'Referrer-Policy': 'no-referrer' };
  const tokens = url.searchParams.getAll('bridge_token');
  if (tokens.length !== 1 || !tokens[0].trim() || tokens[0].length > 4096) {
    return messagePage(res, 400, 'Sign-in link is incomplete', 'Please launch the app again from Kainostore.', { headers });
  }

  const cfg = getConfig();
  if (!cfg.appId) {
    console.error('configuration error: KAINO_APP_ID is not set');
    return messagePage(res, 503, 'Temporarily unavailable', 'The app is not fully configured yet.', { launch: false, headers });
  }

  let session;
  try {
    session = await getKaino().createIntegratedSession(tokens[0], { renewableSession: true });
  } catch (err) {
    const code = err instanceof KainoSdkError ? err.code : 'unknown';
    const status = err instanceof KainoSdkError ? err.status : undefined;
    console.error('callback exchange failed:', code, status ?? '');
    if (status === 401 || status === 409 || status === 400) {
      return messagePage(res, 401, 'Sign-in link expired', 'That link was already used or has expired. Launch again from Kainostore.', { headers });
    }
    return messagePage(res, 503, 'Temporarily unavailable', 'We could not reach Kainostore. Please try again in a moment.', { launch: false, headers });
  }

  if (
    session.appId !== cfg.appId
    || session.entitlementStatus !== 'active'
    || session.integrationStatus !== 'active'
    || !session.renewalToken
    || !session.renewalExpiresAt
  ) {
    console.error('callback rejected: session does not match this app or is not active');
    return messagePage(res, 403, 'Access not available', 'This account does not have access to Healthy Discussion.', { headers });
  }

  const id = await createSession(session);
  res.writeHead(302, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    'Set-Cookie': sessionCookie(id, session.renewalExpiresAt),
    Location: '/',
  });
  res.end();
}

async function logout(req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { ok: false });
  const id = sessionIdFrom(req);
  let platformRevoked = true;
  if (id) {
    const session = await getSession(id).catch(() => null);
    if (session) {
      try {
        await getKaino().revokeIntegratedSession(session);
      } catch (err) {
        platformRevoked = false; // reported, not hidden; the local session is removed regardless
        console.error('platform revocation failed:', err instanceof KainoSdkError ? err.code : 'unknown');
      }
    }
    await deleteSession(id);
  }
  sendJson(res, 200, { ok: true, platformRevoked }, { 'Set-Cookie': clearCookie() });
}

export function createApp() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      const isRead = req.method === 'GET' || req.method === 'HEAD';

      if (url.pathname === '/health' && isRead) return await health(res);
      if (url.pathname === '/api/kaino/callback' && req.method === 'GET') return await callback(req, res, url);
      if (url.pathname === '/api/logout' && req.method === 'POST') return await logout(req, res);

      if (url.pathname === '/assets/session.js' && isRead) {
        return send(res, 200, await readPublic('session.js'), { 'Content-Type': 'text/javascript; charset=utf-8' });
      }

      if (isRead && ['/', '/index.html', '/assets/app.js', '/api/session'].includes(url.pathname)) {
        const auth = await authenticate(req);
        if (auth.status === 'unavailable') {
          if (url.pathname === '/api/session') return sendJson(res, 503, { authenticated: false });
          return messagePage(res, 503, 'Temporarily unavailable', 'We could not confirm your session. Please try again in a moment.', { launch: false });
        }
        if (auth.status === 'none') {
          if (url.pathname === '/api/session') return sendJson(res, 401, { authenticated: false, launchUrl: launchUrl() });
          if (url.pathname === '/assets/app.js') return send(res, 401, 'Sign in required');
          return messagePage(res, 401, 'Sign in with Kainostore', 'Healthy Discussion opens from Kainostore.', {
            headers: sessionIdFrom(req) ? { 'Set-Cookie': clearCookie() } : {},
          });
        }
        if (url.pathname === '/api/session') {
          return sendJson(res, 200, { authenticated: true, expiresAt: auth.session.renewalExpiresAt });
        }
        if (url.pathname === '/assets/app.js') {
          return send(res, 200, await readPublic('app.js'), { 'Content-Type': 'text/javascript; charset=utf-8' });
        }
        return send(res, 200, await readPublic('index.html'), { 'Content-Type': 'text/html; charset=utf-8' });
      }

      send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    } catch (err) {
      console.error('request failed:', err?.code ?? err?.name ?? 'error');
      if (!res.headersSent) send(res, 500, 'Something went wrong', { 'Content-Type': 'text/plain; charset=utf-8' });
      else res.end();
    }
  });
}
