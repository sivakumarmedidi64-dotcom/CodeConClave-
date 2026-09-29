-- 0077: passwordless email OTP auth (single-use, expiring, hashed at rest).
-- Raw codes are never persisted — only an scrypt password-grade hash
-- (same primitive as users.password_hash). Codes are delivered via the
-- existing outbox -> Resend rail.

CREATE TABLE email_otps (
  id          text PRIMARY KEY,
  email       text NOT NULL,
  code_hash   text NOT NULL,
  status      text NOT NULL DEFAULT 'PENDING'
              CHECK (status IN ('PENDING','USED','REVOKED')),
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_otps_email ON email_otps (email);
CREATE INDEX idx_email_otps_active ON email_otps (email, status, expires_at);

ALTER TABLE email_otps ENABLE ROW LEVEL SECURITY;
-- Users may read their own OTP rows (matched via account email); the server
-- performs writes.
CREATE POLICY email_otps_self ON email_otps
  USING (
    EXISTS (SELECT 1 FROM users WHERE id = app.uid() AND lower(email) = lower(email_otps.email))
  ) WITH CHECK (true);