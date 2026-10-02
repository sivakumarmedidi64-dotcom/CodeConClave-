-- ---------------------------------------------------------------------------
-- CodeConClave — Superpowers (Tranche D): intelligence & org-health cluster.
--
--   COWORK REPLAY          (feature 163): every agent session is a replayable,
--                           forkable timeline. A session pins a task at a base
--                           event seq; forking copies the event log into a new
--                           task so a teammate continues without touching the
--                           original branch.
--   ORACLE                 (feature 14): live, ranked risk per file/function/
--                           module (complexity x churn x past failures).
--   ANOMALY HUNTER         (feature 46): deterministic name-vs-behavior checks
--                           (reader-named-mutator, hollow test descriptions,
--                           claimed guards that don't exist in the body).
--   STANDUP FROM REALITY   (feature 136): daily digest built from real artifacts
--                           (events, fix tickets, scans, risks, replays) — never
--                           self-reported.
--   ENGINEERING SIXTH SENSE (feature 155): one GREEN/YELLOW/RED indicator
--                           aggregating the above — a single truthful signal.
--
-- Owned rows + RLS identical to 0079/0080/0081 (app.uid() owner scoping).
-- ---------------------------------------------------------------------------

CREATE TABLE replay_sessions (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  task_id           text NOT NULL,
  base_seq          bigint NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','ARCHIVED')),
  note              text,
  forked_from_task  text,
  forked_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_replay_sessions_owner ON replay_sessions (owner_id, created_at DESC);

ALTER TABLE replay_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY replay_sessions_owner ON replay_sessions USING (owner_id = app.uid());

CREATE TABLE risk_scores (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  target_type       text NOT NULL CHECK (target_type IN ('FILE','FUNCTION','MODULE')),
  target_path       text NOT NULL,
  complexity_score  numeric(5,2) NOT NULL,
  churn_score       numeric(5,2) NOT NULL,
  failure_links     integer NOT NULL DEFAULT 0,
  risk_score        numeric(5,2) NOT NULL,
  risk_band         text NOT NULL CHECK (risk_band IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  reasons           jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, target_type, target_path)
);

CREATE INDEX idx_risk_scores_owner_band ON risk_scores (owner_id, risk_band);

ALTER TABLE risk_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY risk_scores_owner ON risk_scores USING (owner_id = app.uid());

CREATE TABLE anomaly_scans (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  target_type       text NOT NULL CHECK (target_type IN ('CODE','TEST','DOC')),
  target_path       text,
  verdict           text NOT NULL CHECK (verdict IN ('CLEAN','FLAGGED')),
  findings          jsonb NOT NULL DEFAULT '[]',
  status            text NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN','RESOLVED','DISMISSED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_anomaly_scans_owner ON anomaly_scans (owner_id, status, created_at DESC);

ALTER TABLE anomaly_scans ENABLE ROW LEVEL SECURITY;
CREATE POLICY anomaly_scans_owner ON anomaly_scans USING (owner_id = app.uid());

CREATE TABLE standup_reports (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  report_date       date NOT NULL,
  summary           jsonb NOT NULL DEFAULT '{}',
  status            text NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT','PUBLISHED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, report_date)
);

ALTER TABLE standup_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY standup_reports_owner ON standup_reports USING (owner_id = app.uid());

CREATE TABLE health_signals (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  scope             text NOT NULL DEFAULT 'PROJECT',
  verdict           text NOT NULL CHECK (verdict IN ('GREEN','YELLOW','RED')),
  components        jsonb NOT NULL DEFAULT '{}',
  evidence          jsonb NOT NULL DEFAULT '[]',
  computed_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, scope)
);

ALTER TABLE health_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY health_signals_owner ON health_signals USING (owner_id = app.uid());