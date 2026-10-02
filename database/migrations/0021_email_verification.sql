-- 0021: phase 2 — email verification (single-use, expiring tokens).
-- Persisted server-side: raw tokens are never stored; only SHA-256 hashes.
-- Verification links are delivered via the outbox/Resend pipeline.

CREATE TABLE email_verifications (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  status      text NOT NULL DEFAULT 'PENDING'
              CHECK (status IN ('PENDING','USED','REVOKED')),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_verifications_user ON email_verifications (user_id);
CREATE INDEX idx_email_verifications_expires ON email_verifications (status, expires_at);

ALTER TABLE email_verifications ENABLE ROW LEVEL SECURITY;
-- Users may read their own verification records; the server performs writes.
CREATE POLICY email_verifications_self ON email_verifications
  USING (user_id = app.uid()) WITH CHECK (true);