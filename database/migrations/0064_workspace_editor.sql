-- 0064: PKG-22 Advanced Code Workspace (Editor + Navigation + Multi-File + Refactoring).
-- Additive. Introduces per-project persistent workspace editor state (tabs,
-- active, pinned, order, split, restored cursor, recent) and an immutable
-- workspace edit history ledger (version-aware edits with base/new hashes so
-- saves never silently overwrite) plus a workspace review ledger (proposed ->
-- reviewed -> applied for multi-file/AI changes). Builds ON TOP of the existing
-- runtime workspace root (disk), B1 review semantics and canonical diff. NEVER
-- stores source content secrets beyond reviewed diffs; secrets paths are blocked.

-- Persistent multi-file workspace editor state (one row per user+project).
CREATE TABLE IF NOT EXISTS workspaces (
  id          text PRIMARY KEY,
  user_id     text NOT NULL,
  project_id  text NOT NULL REFERENCES projects(id),
  active_path text,
  split       text NOT NULL DEFAULT 'single'
              CHECK (split IN ('single','split-vertical','split-horizontal')),
  layout      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_workspaces_user ON workspaces (user_id, updated_at DESC);

-- Open tabs within a workspace (pinned/order/unsaved/cursor for restoration).
CREATE TABLE IF NOT EXISTS workspace_tabs (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path         text NOT NULL,
  pinned       boolean NOT NULL DEFAULT false,
  tab_order    integer NOT NULL DEFAULT 0,
  unsaved      boolean NOT NULL DEFAULT false,
  saved_sha256 text,
  cursor_line  integer,
  cursor_col   integer,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, path)
);
CREATE INDEX IF NOT EXISTS idx_workspace_tabs_ws ON workspace_tabs (workspace_id, tab_order);

-- Immutable version-aware edit history ledger (no silent overwrite).
CREATE TABLE IF NOT EXISTS workspace_edits (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id   text NOT NULL REFERENCES projects(id),
  path         text NOT NULL,
  base_sha256  text NOT NULL,
  new_sha256   text NOT NULL,
  source       text NOT NULL DEFAULT 'manual',
  change_reason text,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workspace_edits_ws ON workspace_edits (workspace_id, created_at DESC);

-- Workspace review ledger: proposed content snapshots + per-file review status
-- (mirrors B1 hunk semantics; canonical diff; no parallel authority).
CREATE TABLE IF NOT EXISTS workspace_reviews (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id    text NOT NULL REFERENCES projects(id),
  title         text,
  status        text NOT NULL DEFAULT 'READY_FOR_REVIEW',
  files_changed integer NOT NULL DEFAULT 0,
  additions     integer NOT NULL DEFAULT 0,
  deletions     integer NOT NULL DEFAULT 0,
  diff_text     text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workspace_reviews_ws ON workspace_reviews (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_review_files (
  id          text PRIMARY KEY,
  review_id   text NOT NULL REFERENCES workspace_reviews(id) ON DELETE CASCADE,
  path        text NOT NULL,
  base_sha256 text NOT NULL,
  base_content text,
  proposed_sha256 text NOT NULL,
  proposed_content text,
  accepted    boolean NOT NULL DEFAULT false,
  applied     boolean NOT NULL DEFAULT false,
  file_order  integer NOT NULL DEFAULT 0,
  UNIQUE (review_id, path)
);
CREATE INDEX IF NOT EXISTS idx_ws_review_files_rev ON workspace_review_files (review_id, file_order);
