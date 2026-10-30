import { createHash, randomBytes } from 'node:crypto';
import { getPool } from './db.mjs';

export const COOKIE_NAME = '__Host-hd_session';

const hash = (id) => createHash('sha256').update(id).digest('hex');

// Keep only the SDK's session fields (drops the verified-claim extras).
export function toStoredSession(s) {
  const keep = [
    'appId', 'appSlug', 'appScopedUserId', 'entitlementId', 'entitlementStatus',
    'integrationStatus', 'sessionAssertion', 'issuedAt', 'assertionExpiresAt',
    'renewalToken', 'renewalExpiresAt',
  ];
  return Object.fromEntries(keep.filter((k) => s[k] !== undefined).map((k) => [k, s[k]]));
}

export async function createSession(session) {
  const id = randomBytes(32).toString('base64url');
  const stored = toStoredSession(session);
  await getPool().query(
    `INSERT INTO app_sessions (id_hash, app_scoped_user_id, session, renewal_expires_at)
     VALUES ($1, $2, $3, $4)`,
    [hash(id), stored.appScopedUserId, stored, stored.renewalExpiresAt],
  );
  return id;
}

export async function getSession(id) {
  if (typeof id !== 'string' || id.length < 20 || id.length > 100) return null;
  const { rows } = await getPool().query(
    'SELECT session FROM app_sessions WHERE id_hash = $1',
    [hash(id)],
  );
  return rows[0]?.session ?? null;
}

// Persist a renewed session only if the row still exists with the same renewal
// credential, so a late renewal can never resurrect a logged-out session.
export async function saveRenewed(id, previous, next) {
  const stored = toStoredSession(next);
  const { rowCount } = await getPool().query(
    `UPDATE app_sessions
        SET session = $2, updated_at = now()
      WHERE id_hash = $1 AND session->>'renewalToken' = $3`,
    [hash(id), stored, previous.renewalToken],
  );
  return rowCount === 1;
}

export async function deleteSession(id) {
  if (typeof id !== 'string' || !id) return;
  await getPool().query('DELETE FROM app_sessions WHERE id_hash = $1', [hash(id)]);
}

export async function purgeExpired() {
  const { rowCount } = await getPool().query(
    'DELETE FROM app_sessions WHERE renewal_expires_at < now()',
  );
  return rowCount;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionCookie(id, renewalExpiresAt) {
  const maxAge = Math.max(0, Math.floor((Date.parse(renewalExpiresAt) - Date.now()) / 1000));
  return `${COOKIE_NAME}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
