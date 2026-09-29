-- ---------------------------------------------------------------------------
-- CodeConClave — Superpowers (Tranche A).
--
-- The foundation "laws" of the Master Feature prompt, implemented as genuine,
-- additive, tested backend capabilities:
--
--   PROOF-OF-RUN        (feature 34 + 70 PROOF BADGE + 71 WHY-BUTTON):
--                       every agent claim must attach executable evidence
--                       (passing test, benchmark, log excerpt, artifact) or it
--                       is labeled UNVERIFIED. The verdict is computed by the
--                       server, never fabricated by the caller.
--   ECHO MEMORY         (feature 33): every human correction/override becomes a
--                       labeled lesson bound to a module scope, retrieved
--                       before future tasks in that area.
--   WARDEN              (feature 29): policy graph over module boundaries.
--                       Forbidden/required dependency rules are encoded and
--                       every proposed change is checked against them before it
--                       can proceed.
--   SPEC LINTER         (feature 13): documented endpoints / env vars / SLAs
--                       compared against reality; drift is recorded with
--                       evidence, never silently hidden.
--   CHECKPOINT T.M.     (feature 68): each cowork task auto-checkpoints; a
--                       checkpoint can be rewound, forked, or restored.
--
-- Each claim lesson / policy / spec / checkpoint is tenant-owned; RLS follows
-- the pattern of 0015_rls.sql (owner-scoped reads/writes via app uid()).
-- ---------------------------------------------------------------------------

CREATE TABLE proof_claims (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    text REFERENCES projects(id) ON DELETE CASCADE,
  task_id       text,
  claim         text NOT NULL,
  subject       text,
  evidence_kind text NOT NULL DEFAULT 'NONE'
                CHECK (evidence_kind IN ('TEST_RUN','BENCHMARK','LOG','ARTIFACT','SCREENSHOT','NONE')),
  evidence_ref  text,
  verdict       text NOT NULL DEFAULT 'UNVERIFIED'
                CHECK (verdict IN ('VERIFIED','PARTIAL','UNVERIFIED')),
  why_trace     jsonb NOT NULL DEFAULT '[]',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_proof_claims_owner ON proof_claims (owner_id, created_at DESC);
CREATE INDEX idx_proof_claims_task ON proof_claims (task_id);

ALTER TABLE proof_claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY proof_claims_owner ON proof_claims USING (owner_id = app.uid());

CREATE TABLE echo_lessons (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    text REFERENCES projects(id) ON DELETE CASCADE,
  module_scope  text NOT NULL DEFAULT 'GLOBAL',
  label         text NOT NULL,
  lesson        text NOT NULL,
  source        text NOT NULL DEFAULT 'CORRECTION'
                CHECK (source IN ('CORRECTION','OVERRIDE','REVIEW')),
  applied_count integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_echo_lessons_owner_scope ON echo_lessons (owner_id, module_scope, created_at DESC);

ALTER TABLE echo_lessons ENABLE ROW LEVEL SECURITY;
CREATE POLICY echo_lessons_owner ON echo_lessons USING (owner_id = app.uid());

CREATE TABLE warden_policies (
  id               text PRIMARY KEY,
  owner_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id       text REFERENCES projects(id) ON DELETE CASCADE,
  name             text NOT NULL,
  description      text,
  forbidden_imports jsonb NOT NULL DEFAULT '[]',
  required_imports jsonb NOT NULL DEFAULT '[]',
  enabled          boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_warden_policies_owner ON warden_policies (owner_id, created_at DESC);

ALTER TABLE warden_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY warden_policies_owner ON warden_policies USING (owner_id = app.uid());

CREATE TABLE spec_entries (
  id              text PRIMARY KEY,
  owner_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id      text REFERENCES projects(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('ENDPOINT','ENV_VAR','SLA')),
  name            text NOT NULL,
  expectation     text,
  status          text NOT NULL DEFAULT 'UNCHECKED'
                  CHECK (status IN ('UNCHECKED','OK','DRIFT')),
  evidence        jsonb NOT NULL DEFAULT '{}',
  last_checked_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_spec_entries_owner ON spec_entries (owner_id, created_at DESC);

ALTER TABLE spec_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY spec_entries_owner ON spec_entries USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS task_checkpoint_manifests (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id       text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id    text REFERENCES projects(id) ON DELETE CASCADE,
  label         text,
  manifest      jsonb NOT NULL DEFAULT '{}',
  forked_from   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_checkpoint_manifests_owner_task ON task_checkpoint_manifests (owner_id, task_id, created_at DESC);

ALTER TABLE task_checkpoint_manifests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS task_checkpoints_owner ON task_checkpoint_manifests;
CREATE POLICY task_checkpoint_manifests_owner ON task_checkpoint_manifests USING (owner_id = app.uid());