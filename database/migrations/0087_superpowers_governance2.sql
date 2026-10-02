-- ---------------------------------------------------------------------------
-- CodeConClave — Superpowers (Tranche I): self-governance & quality cluster 2.
--
--   ADVERSARIAL SUITE       (feature 35): a dedicated adversary reviews every
--                           change — edge inputs, race conditions, permission
--                           escapes, resource exhaustion, null paths — and
--                           blocks the change with specific evidence when one
--                           is found.
--   MUTATION-GRADE TESTS    (feature 36): every generated test is run against
--                           an intentionally-broken copy of the code; tests
--                           that still pass are hollow and rejected. Only
--                           sensitive tests ship.
--   SHADOW EXECUTION        (feature 39): critical paths run the new build in a
--                           shadow environment against mirrored read-only
--                           traffic; latency, errors and response diffs are
--                           compared, and any mismatch blocks production.
--   PRIVILEGE SHRINKER      (feature 41): continuously audits grants and flags
--                           over-permissioned items with the minimal-privilege
--                           rewrite ready to apply.
--   AGENT SANDBOX ISOLATION (feature 44): every agent action is adjudicated
--                           against a sandbox policy — network egress
--                           allowlist, filesystem jail, credential vault — and
--                           every call is logged for a full audit trail.
--
-- Owned rows + RLS identical to 0079..0086 (app.uid() scoping).
-- ---------------------------------------------------------------------------

CREATE TABLE adversarial_runs (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  change_ref        text NOT NULL,
  verdict           text NOT NULL DEFAULT 'PASS'
                    CHECK (verdict IN ('PASS','BLOCKED')),
  findings          jsonb NOT NULL DEFAULT '[]',
  generated_attacks jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_adversarial_runs_owner ON adversarial_runs (owner_id, created_at DESC);

ALTER TABLE adversarial_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY adversarial_runs_owner ON adversarial_runs USING (owner_id = app.uid());

CREATE TABLE mutation_sweeps (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  targets           integer NOT NULL DEFAULT 0,
  sensitive         integer NOT NULL DEFAULT 0,
  hollow            integer NOT NULL DEFAULT 0,
  accepted          jsonb NOT NULL DEFAULT '[]',
  rejected          jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_mutation_sweeps_owner ON mutation_sweeps (owner_id, created_at DESC);

ALTER TABLE mutation_sweeps ENABLE ROW LEVEL SECURITY;
CREATE POLICY mutation_sweeps_owner ON mutation_sweeps USING (owner_id = app.uid());

CREATE TABLE shadow_runs (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  release_ref       text NOT NULL,
  mirrored          integer NOT NULL DEFAULT 0,
  mismatches        integer NOT NULL DEFAULT 0,
  verdict           text NOT NULL DEFAULT 'PASS'
                    CHECK (verdict IN ('PASS','BLOCKED')),
  mismatches_detail jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_shadow_runs_owner ON shadow_runs (owner_id, created_at DESC);

ALTER TABLE shadow_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY shadow_runs_owner ON shadow_runs USING (owner_id = app.uid());

CREATE TABLE privilege_flags (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  principal         text NOT NULL,
  resource          text NOT NULL,
  action            text NOT NULL,
  scope             text NOT NULL,
  severity          text NOT NULL
                    CHECK (severity IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  minimal_rewrite   text NOT NULL,
  status            text NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN','SHRUNK')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_privilege_flags_owner ON privilege_flags (owner_id, status);

ALTER TABLE privilege_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY privilege_flags_owner ON privilege_flags USING (owner_id = app.uid());

CREATE TABLE sandbox_policies (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_name        text NOT NULL,
  egress_allowlist  jsonb NOT NULL DEFAULT '[]',
  fs_jail_root      text NOT NULL,
  credentials_vault boolean NOT NULL DEFAULT true,
  syscall_logging   boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, agent_name)
);

CREATE INDEX idx_sandbox_policies_owner ON sandbox_policies (owner_id, agent_name);

ALTER TABLE sandbox_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY sandbox_policies_owner ON sandbox_policies USING (owner_id = app.uid());

CREATE TABLE sandbox_actions (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  policy_id         text NOT NULL REFERENCES sandbox_policies(id) ON DELETE CASCADE,
  run_ref           text NOT NULL,
  kind              text NOT NULL
                    CHECK (kind IN ('NETWORK_CALL','FILE_ACCESS','CREDENTIAL_READ','SYS_CALL')),
  target            text NOT NULL,
  decision          text NOT NULL
                    CHECK (decision IN ('ALLOWED','BLOCKED')),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sandbox_actions_owner ON sandbox_actions (owner_id, run_ref);

ALTER TABLE sandbox_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY sandbox_actions_owner ON sandbox_actions USING (owner_id = app.uid());