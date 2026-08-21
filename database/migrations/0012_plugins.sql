-- 0012: plugins — catalogue, connections, scopes, events

CREATE TABLE plugins (
  plugin_type     text PRIMARY KEY CHECK (plugin_type IN ('github','slack','vercel','vscode','webhook')),
  name            text NOT NULL,
  description     text,
  capabilities    jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_connections (
  id                   text PRIMARY KEY,
  owner_id             text NOT NULL REFERENCES users(id),
  plugin_type          text NOT NULL REFERENCES plugins(plugin_type),
  name                 text NOT NULL,
  state                text NOT NULL DEFAULT 'DISCONNECTED'
                       CHECK (state IN ('DISCONNECTED','CONNECTING','CONNECTED','ERROR','REVOKED')),
  scopes               jsonb NOT NULL DEFAULT '[]'::jsonb,
  credential_ref       text,
  last_health_check_at timestamptz,
  last_error           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_plugin_connections UNIQUE (owner_id, plugin_type)
);

CREATE INDEX idx_plugin_connections_owner ON plugin_connections (owner_id);

CREATE TRIGGER trg_plugin_connections_updated_at
  BEFORE UPDATE ON plugin_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE plugin_scopes (
  id             text PRIMARY KEY,
  connection_id  text NOT NULL REFERENCES plugin_connections(id),
  scope          text NOT NULL,
  granted_at     timestamptz NOT NULL,
  expires_at     timestamptz,
  revoked_at     timestamptz
);

CREATE INDEX idx_plugin_scopes_connection ON plugin_scopes (connection_id);

CREATE TABLE plugin_events (
  id             text PRIMARY KEY,
  connection_id  text NOT NULL REFERENCES plugin_connections(id),
  event_type     text NOT NULL,
  payload        jsonb,
  state          text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_plugin_events_connection_created ON plugin_events (connection_id, created_at);