-- Server-side sessions for Kainostore launch/login.
-- The browser only ever holds an opaque random id; the table stores its SHA-256
-- hash. "session" holds the SDK session including the backend-only renewal
-- credential, which must never be sent to the browser.
CREATE TABLE IF NOT EXISTS app_sessions (
  id_hash            text        PRIMARY KEY,
  app_scoped_user_id text        NOT NULL,
  session            jsonb       NOT NULL,
  renewal_expires_at timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_sessions_renewal_expires_at_idx
  ON app_sessions (renewal_expires_at);
