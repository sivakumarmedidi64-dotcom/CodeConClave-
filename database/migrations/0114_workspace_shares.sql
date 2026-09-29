-- Stage — project workspace share links (public + private).
-- Unique share tokens let users share a co-working space with anyone (public)
-- or with specific team members (private). Public links require no auth on view.
-- Additive only. Every tenant table: owner_id + RLS + FKs + indexes.

CREATE TABLE workspace_shares (
  id              text PRIMARY KEY,
  owner_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id      text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  token           text NOT NULL UNIQUE CHECK (token <> ''),
  visibility      text NOT NULL DEFAULT 'PUBLIC' CHECK (visibility IN ('PUBLIC','PRIVATE')),
  mode            text NOT NULL DEFAULT 'WATCH' CHECK (mode IN ('WATCH','COMMENT','CO_CONTROL')),
  expires_at      timestamptz,
  one_time        boolean NOT NULL DEFAULT false,
  redeemed_by     text,
  redeemed_at     timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_workspace_shares_owner ON workspace_shares (owner_id, created_at DESC);
CREATE INDEX idx_workspace_shares_project ON workspace_shares (project_id, created_at DESC);
CREATE INDEX idx_workspace_shares_token ON workspace_shares (token);