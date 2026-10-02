-- 0032: phase 10 — plugin isolation, encrypted credentials, health, idempotency
-- Extends the Phase 4 plugin schema. Static-validated only (no PostgreSQL runtime).

-- 1) Expand catalogue + connection types with the Phase 10 adapters (google, resend).
ALTER TABLE plugins DROP CONSTRAINT plugins_plugin_type_check;
ALTER TABLE plugins ADD CONSTRAINT plugins_plugin_type_check
  CHECK (plugin_type IN ('github','google','resend','slack','vercel','vscode','webhook'));

ALTER TABLE plugin_connections DROP CONSTRAINT plugin_connections_plugin_type_fkey;
ALTER TABLE plugin_connections DROP CONSTRAINT plugin_connections_state_check;
ALTER TABLE plugin_connections ADD CONSTRAINT plugin_connections_plugin_type_fkey
  FOREIGN KEY (plugin_type) REFERENCES plugins(plugin_type);
ALTER TABLE plugin_connections ADD CONSTRAINT plugin_connections_state_check
  CHECK (state IN (
    'DISCONNECTED','CONNECTING','CONNECTED','DEGRADED','FAILED',
    'REAUTH_REQUIRED','ERROR','REVOKED'));

-- 2) Encrypted credential store. Raw secrets never live in normal plugin tables.
CREATE TABLE plugin_credentials (
  id              text PRIMARY KEY,
  connection_id   text NOT NULL REFERENCES plugin_connections(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN (
                    'token','api_key','refresh_token','access_token','secret','oauth_scopes')),
  value_encrypted text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz
);

CREATE INDEX idx_plugin_credentials_connection ON plugin_credentials (connection_id);
CREATE UNIQUE INDEX uq_plugin_credentials_connection_kind
  ON plugin_credentials (connection_id, kind) WHERE revoked_at IS NULL;

CREATE TRIGGER trg_plugin_credentials_updated_at
  BEFORE UPDATE ON plugin_credentials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3) Health ledger: every check/action outcome is persisted (append-only).
CREATE TABLE plugin_health (
  id                   text PRIMARY KEY,
  connection_id        text NOT NULL REFERENCES plugin_connections(id) ON DELETE CASCADE,
  checked_at           timestamptz NOT NULL DEFAULT now(),
  ok                   boolean NOT NULL,
  latency_ms           integer NOT NULL DEFAULT 0,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_error           text,
  detail               jsonb
);

CREATE INDEX idx_plugin_health_connection_checked ON plugin_health (connection_id, checked_at);

-- 4) Idempotency records for external write/send/publish actions.
CREATE TABLE plugin_idempotency (
  id               text PRIMARY KEY,
  connection_id    text NOT NULL REFERENCES plugin_connections(id) ON DELETE CASCADE,
  action           text NOT NULL,
  idempotency_key  text NOT NULL,
  response         jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  CONSTRAINT uq_plugin_idempotency UNIQUE (connection_id, action, idempotency_key)
);

CREATE INDEX idx_plugin_idempotency_connection_created ON plugin_idempotency (connection_id, created_at);

-- 5) Event retention index (events older than 30 days are pruned by the watchdog).
CREATE INDEX idx_plugin_events_created ON plugin_events (created_at);

-- 6) Phase 10 catalogue entries.
INSERT INTO plugins (plugin_type, name, description, capabilities) VALUES
  ('google', 'Google Workspace',
   'Gmail, Drive, Sheets and Calendar through the existing Google OAuth application (encrypted server-side tokens).',
   '["gmail","drive","sheets","calendar"]'),
  ('resend', 'Resend Email',
   'Transactional email send + delivery status through the existing Resend/outbox architecture.',
   '["email"]')
ON CONFLICT (plugin_type) DO NOTHING;

-- 7) RLS for the new tables (tenant isolation via connection owner).
ALTER TABLE plugin_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY plugin_credentials_owner ON plugin_credentials
  USING (EXISTS (
    SELECT 1 FROM plugin_connections pc WHERE pc.id = plugin_credentials.connection_id AND pc.owner_id = app.uid()
  ));

ALTER TABLE plugin_health ENABLE ROW LEVEL SECURITY;
CREATE POLICY plugin_health_owner ON plugin_health
  USING (EXISTS (
    SELECT 1 FROM plugin_connections pc WHERE pc.id = plugin_health.connection_id AND pc.owner_id = app.uid()
  ));

ALTER TABLE plugin_idempotency ENABLE ROW LEVEL SECURITY;
CREATE POLICY plugin_idempotency_owner ON plugin_idempotency
  USING (EXISTS (
    SELECT 1 FROM plugin_connections pc WHERE pc.id = plugin_idempotency.connection_id AND pc.owner_id = app.uid()
  ));