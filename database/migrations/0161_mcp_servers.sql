-- 0161: MCP (Model Context Protocol) servers a user connects (constitution
-- Article 8). Remote servers over Streamable HTTP. The auth header value is
-- stored encrypted at rest (AES-256-GCM, shared/crypto encryptAtRest) and is
-- never returned by the API. Discovered tools are cached so the policy engine
-- can rely on the server's own read-only/destructive labels (never the
-- model's claims).

CREATE TABLE IF NOT EXISTS mcp_servers (
  id                 text PRIMARY KEY,
  user_id            text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               text NOT NULL CHECK (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(name) <= 32),
  url                text NOT NULL CHECK (length(url) <= 2048),
  auth_header_name   text CHECK (auth_header_name IS NULL OR auth_header_name ~ '^[A-Za-z0-9-]{1,64}$'),
  auth_header_enc    text,
  enabled            boolean NOT NULL DEFAULT true,
  status             text NOT NULL DEFAULT 'UNKNOWN' CHECK (status IN ('UNKNOWN','CONNECTED','FAILED')),
  last_error         text,
  server_info        jsonb,
  protocol_version   text,
  tools              jsonb NOT NULL DEFAULT '[]'::jsonb,
  tools_refreshed_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_mcp_servers_user ON mcp_servers (user_id, created_at);

ALTER TABLE mcp_servers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mcp_servers_self ON mcp_servers;
CREATE POLICY mcp_servers_self ON mcp_servers USING (user_id = app.uid());
