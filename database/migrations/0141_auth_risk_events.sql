-- ---------------------------------------------------------------------------
-- 0141_auth_risk_events.sql
-- Zero-domain authentication: server-authoritative device/risk signals.
--
-- Risk signals (unknown device, rapid device switch, key-challenge
-- pass/fail) may trigger additional verification, a temporary lock, or a
-- security review — never a permanent ban and never a paid unban. Geo/device
-- signals are evidence, not proof. All decisions stay server-side; the client
-- never bans. Rows are append-only signal history next to audit_logs.
-- Additive only.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS auth_risk_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signal TEXT NOT NULL,
  action TEXT NOT NULL,
  device_id TEXT NULL,
  ip TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_risk_events_user_created
  ON auth_risk_events (user_id, created_at DESC);
