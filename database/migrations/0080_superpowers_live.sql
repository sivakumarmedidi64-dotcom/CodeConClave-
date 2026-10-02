-- ---------------------------------------------------------------------------
-- CodeConClave — Superpowers (Tranche B): realtime autonomy branch.
--
--   LIVE DIFF WATCH    (feature 67): append-only event log of agent work
--                      (file_changed patches, comments, checkpoints) streamed
--                      to the editor over SSE with Last-Event-ID replay. You
--                      comment; the coworker adjusts mid-task.
--   AUTO-FIX INBOX     (feature 69): every CI failure / Sentry error / broken
--                      preview / failed deploy becomes a fix ticket with an
--                      Auto-Fix flow (reproduce -> fix -> PR with proof).
--   INTENTION COMPLETION (feature 59): "// intent" comments become a generated
--                      implementation draft + test scaffold + doc; applying
--                      records the comment for deletion (code speaks).
--
-- Owned rows + RLS identical to 0079 (app.uid() pattern, owner-scoped reads).
-- ---------------------------------------------------------------------------

CREATE TABLE agent_events (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    text REFERENCES projects(id) ON DELETE CASCADE,
  task_id       text NOT NULL,
  run_id        text,
  seq           bigserial NOT NULL,
  kind          text NOT NULL
                CHECK (kind IN ('task_created','file_changed','comment','checkpoint_created','fix_requested','intent_detected')),
  path          text,
  patch         text,
  payload       jsonb NOT NULL DEFAULT '{}',
  source_uid    text,               -- user id when a comment/decision is authored
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_events_owner_task ON agent_events (owner_id, task_id, seq);
CREATE INDEX idx_agent_events_owner_seq ON agent_events (owner_id, seq);

ALTER TABLE agent_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_events_owner ON agent_events USING (owner_id = app.uid());

CREATE TABLE fix_tickets (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    text REFERENCES projects(id) ON DELETE CASCADE,
  source        text NOT NULL
                CHECK (source IN ('ci_failure','sentry_error','preview_broken','deploy_failed','manual')),
  issue         text NOT NULL,
  ref           text,               -- external ref: build id, sentry id, deploy id...
  status        text NOT NULL DEFAULT 'OPEN'
                CHECK (status IN ('OPEN','IN_REPRODUCTION','FIX_PROPOSED','PR_OPENED','RESOLVED','SUPERSEDED')),
  title         text,
  error_snippet text,
  pr_url        text,
  proof_claim_id text REFERENCES proof_claims(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fix_tickets_owner ON fix_tickets (owner_id, status, created_at DESC);

ALTER TABLE fix_tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY fix_tickets_owner ON fix_tickets USING (owner_id = app.uid());

CREATE TABLE intent_drafts (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    text REFERENCES projects(id) ON DELETE CASCADE,
  file          text NOT NULL,
  intent        text NOT NULL,          -- the comment body
  language      text NOT NULL DEFAULT 'javascript',
  generated     jsonb NOT NULL DEFAULT '{}',  -- { functionName, signature, body, jsdoc, testSnippet }
  comment_marker text,                  -- editor marker that deletes the comment once applied
  status        text NOT NULL DEFAULT 'DRAFT'
                CHECK (status IN ('DRAFT','APPLIED','DISMISSED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_intent_drafts_owner ON intent_drafts (owner_id, status, created_at DESC);

ALTER TABLE intent_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY intent_drafts_owner ON intent_drafts USING (owner_id = app.uid());