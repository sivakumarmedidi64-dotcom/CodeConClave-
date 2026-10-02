-- ---------------------------------------------------------------------------
-- CodeConClave — Superpowers (Tranche L): autonomous execution.
--
--   AUTOPILOT PRIME   (feature 1):  one plain-English goal -> task DAG ->
--                                    end-to-end execution with self-repair on
--                                    failure -> diff + summary + test results.
--   PHOENIX PROTOCOL  (feature 3):  CI pipeline fails -> reproduce at the exact
--                                    commit with the exact env -> fix -> run the
--                                    full suite -> only open a PR once green.
--   LAUNCH CAPTAIN    (feature 4):  owns everything between merge and deploy:
--                                    change classification, semver bump, release
--                                    notes, the deploy itself, rollback.
--   AUTOPSY           (feature 5):  production incident -> correlate with recent
--                                    deploys -> timeline -> postmortem -> fix PR
--                                    when confidence exceeds 80%.
--   SELF-HEALING CI   (feature 8):  predicts CI failure from historical failure
--                                    signatures BEFORE a PR enters the pipeline
--                                    and pre-empts it with the likely fix.
--
-- Owned rows + RLS identical to 0079..0089 (app.uid() scoping).
-- ---------------------------------------------------------------------------

CREATE TABLE autopilot_runs (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal        text NOT NULL,
  node_count  integer NOT NULL DEFAULT 0,
  executed    integer NOT NULL DEFAULT 0,
  retries     integer NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'COMPLETE'
              CHECK (status IN ('COMPLETE','FAILED')),
  summary     text NOT NULL DEFAULT '',
  diff        text NOT NULL DEFAULT '',
  test_results jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_autopilot_runs_owner ON autopilot_runs (owner_id, created_at DESC);

ALTER TABLE autopilot_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY autopilot_runs_owner ON autopilot_runs USING (owner_id = app.uid());

CREATE TABLE phoenix_cycles (
  id           text PRIMARY KEY,
  owner_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pipeline     text NOT NULL,
  commit       text NOT NULL,
  failure      text NOT NULL,
  env          jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'REPRODUCED'
               CHECK (status IN ('REPRODUCED','FIX_READY','SUITE_GREEN','PR_OPENED')),
  fix          text,
  suite_result text,
  pr_number    text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_phoenix_cycles_owner ON phoenix_cycles (owner_id, pipeline);

ALTER TABLE phoenix_cycles ENABLE ROW LEVEL SECURITY;
CREATE POLICY phoenix_cycles_owner ON phoenix_cycles USING (owner_id = app.uid());

CREATE TABLE launch_releases (
  id           text PRIMARY KEY,
  owner_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version      text NOT NULL,
  bump         text NOT NULL DEFAULT 'none'
               CHECK (bump IN ('major','minor','patch','none')),
  notes        text NOT NULL DEFAULT '',
  changes      jsonb NOT NULL DEFAULT '[]',
  status       text NOT NULL DEFAULT 'PLANNED'
               CHECK (status IN ('PLANNED','DEPLOYED','ROLLED_BACK')),
  deployed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_launch_releases_owner ON launch_releases (owner_id, created_at DESC);

ALTER TABLE launch_releases ENABLE ROW LEVEL SECURITY;
CREATE POLICY launch_releases_owner ON launch_releases USING (owner_id = app.uid());

CREATE TABLE autopsy_incidents (
  id             text PRIMARY KEY,
  owner_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  incident       text NOT NULL,
  window_seconds integer NOT NULL DEFAULT 900,
  status         text NOT NULL DEFAULT 'DRAFTED'
                 CHECK (status IN ('DRAFTED','PROPOSED','RESOLVED')),
  suspects       jsonb NOT NULL DEFAULT '[]',
  timeline       jsonb NOT NULL DEFAULT '[]',
  confidence     numeric NOT NULL DEFAULT 0,
  postmortem     text NOT NULL DEFAULT '',
  proposed_fix   jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_autopsy_incidents_owner ON autopsy_incidents (owner_id, created_at DESC);

ALTER TABLE autopsy_incidents ENABLE ROW LEVEL SECURITY;
CREATE POLICY autopsy_incidents_owner ON autopsy_incidents USING (owner_id = app.uid());

CREATE TABLE self_heal_scans (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  diff              text NOT NULL,
  matched_signature text,
  score             integer NOT NULL DEFAULT 0,
  likely_fix        text,
  action            text NOT NULL
                    CHECK (action IN ('PREEMPTED','CLEAN')),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_self_heal_scans_owner ON self_heal_scans (owner_id, created_at DESC);

ALTER TABLE self_heal_scans ENABLE ROW LEVEL SECURITY;
CREATE POLICY self_heal_scans_owner ON self_heal_scans USING (owner_id = app.uid());