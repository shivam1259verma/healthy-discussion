import { KainoSdkError } from '@kainostore/sdk/server';
import { getConfig } from './config.mjs';
import { getKaino } from './kaino.mjs';
import {
  COOKIE_NAME, deleteSession, getSession, parseCookies, saveRenewed,
} from './sessions.mjs';

const RENEW_WINDOW_MS = 60 * 1000;

// jose errors that mean "this assertion is not valid", as opposed to a transient
// failure fetching signing keys. Only the former clears the session.
const INVALID_ASSERTION = new Set([
  'ERR_JWT_EXPIRED', 'ERR_JWT_CLAIM_VALIDATION_FAILED', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWKS_NO_MATCHING_KEY', 'ERR_JWKS_MULTIPLE_MATCHING_KEYS', 'ERR_JWS_INVALID', 'ERR_JWT_INVALID',
  'ERR_JOSE_ALG_NOT_ALLOWED',
]);

const renewals = new Map(); // one in-flight renewal per session per process

export function sessionIdFrom(req) {
  return parseCookies(req.headers.cookie)[COOKIE_NAME] ?? null;
}

function isDefinitiveRejection(err) {
  return err instanceof KainoSdkError
    && (err.status === 401 || err.status === 403 || err.code === 'session_renewal_required');
}

function renewOnce(id, session) {
  let p = renewals.get(id);
  if (!p) {
    p = (async () => {
      const next = await getKaino().renewIntegratedSession(session);
      return next;
    })().finally(() => renewals.delete(id));
    renewals.set(id, p);
  }
  return p;
}

/**
 * Resolve the request's session.
 *  { status: 'ok', subject, session }   authenticated; subject is the verified, app-scoped Kainostore user
 *  { status: 'none' }                   no valid session: offer a fresh Kainostore launch
 *  { status: 'unavailable' }            could not confirm (platform/network); fail closed, keep the session
 */
export async function authenticate(req) {
  const id = sessionIdFrom(req);
  if (!id) return { status: 'none' };

  let session = await getSession(id);
  if (!session) return { status: 'none' };

  const cfg = getConfig();
  if (!cfg.appId || session.appId !== cfg.appId) {
    await deleteSession(id);
    return { status: 'none' };
  }

  const absolute = Date.parse(session.renewalExpiresAt ?? session.assertionExpiresAt);
  if (!Number.isFinite(absolute) || absolute <= Date.now()) {
    await deleteSession(id);
    return { status: 'none' };
  }

  if (Date.parse(session.assertionExpiresAt) - Date.now() < RENEW_WINDOW_MS) {
    try {
      const renewed = await renewOnce(id, session);
      const saved = await saveRenewed(id, session, renewed);
      if (!saved) {
        // Another process renewed it, or the user logged out meanwhile: reload.
        session = await getSession(id);
        if (!session) return { status: 'none' };
      } else {
        session = renewed;
      }
    } catch (err) {
      if (isDefinitiveRejection(err)) {
        await deleteSession(id);
        return { status: 'none' };
      }
      return { status: 'unavailable' };
    }
  }

  try {
    const verified = await getKaino().verifySessionAssertion(session);
    if (Date.parse(session.assertionExpiresAt) <= Date.now()) {
      return { status: 'unavailable' };
    }
    return { status: 'ok', subject: verified.subject, session };
  } catch (err) {
    const joseCode = err?.cause?.code;
    if (err instanceof KainoSdkError && (err.code === 'assertion_subject_mismatch' || INVALID_ASSERTION.has(joseCode))) {
      await deleteSession(id);
      return { status: 'none' };
    }
    return { status: 'unavailable' };
  }
}
