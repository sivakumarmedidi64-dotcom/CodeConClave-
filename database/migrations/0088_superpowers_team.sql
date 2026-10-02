-- ---------------------------------------------------------------------------
-- CodeConClave — Superpowers (Tranche J): team & organization scale.
--
--   BUS-FACTOR ALARM       (feature 133): flags modules owned by too few
--                           humans — with a pairing / knowledge-transfer plan —
--                           so a single departure can never strand the system.
--   REVIEW ROUTER          (feature 134): every PR routed to the reviewer with
--                           the deepest expertise, availability and load taken
--                           into account.
--   PAIRING SCHEDULER      (feature 139): automatically pairs senior and junior
--                           developers on complex tasks so knowledge transfer
--                           becomes systematic instead of accidental.
--   ONBOARDING ROADMAP     (feature 140): generates a personalized first-week
--                           task roadmap scoped to role, team and seniority.
--   ASYNC DECISION PLATFORM (feature 142): major decisions made async with
--                           structured voting, evidence and recorded dissent.
--
-- Owned rows + RLS identical to 0079..0087 (app.uid() scoping).
-- ---------------------------------------------------------------------------

CREATE TABLE bus_factor_alarms (
  id                  text PRIMARY KEY,
  owner_id            text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id          text REFERENCES projects(id) ON DELETE CASCADE,
  module              text NOT NULL,
  total_contributors  integer NOT NULL,
  active_contributors integer NOT NULL,
  span_days           integer NOT NULL,
  severity            text NOT NULL
                      CHECK (severity IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  knowledge_transfer  jsonb NOT NULL DEFAULT '{}',
  status              text NOT NULL DEFAULT 'OPEN'
                      CHECK (status IN ('OPEN','CLEARED')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_bus_factor_alarms_owner ON bus_factor_alarms (owner_id, status);

ALTER TABLE bus_factor_alarms ENABLE ROW LEVEL SECURITY;
CREATE POLICY bus_factor_alarms_owner ON bus_factor_alarms USING (owner_id = app.uid());

CREATE TABLE review_assignments (
  id               text PRIMARY KEY,
  owner_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id       text REFERENCES projects(id) ON DELETE CASCADE,
  module           text NOT NULL,
  selected_reviewer text NOT NULL,
  expertise_score  integer NOT NULL,
  open_load        integer NOT NULL DEFAULT 0,
  ranking          jsonb NOT NULL DEFAULT '[]',
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_review_assignments_owner ON review_assignments (owner_id, created_at DESC);

ALTER TABLE review_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY review_assignments_owner ON review_assignments USING (owner_id = app.uid());

CREATE TABLE pairing_schedules (
  id              text PRIMARY KEY,
  owner_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id      text REFERENCES projects(id) ON DELETE CASCADE,
  task            text NOT NULL,
  complexity      text NOT NULL
                  CHECK (complexity IN ('SIMPLE','MODERATE','COMPLEX','CRITICAL')),
  senior          text NOT NULL,
  junior          text NOT NULL,
  pairing_reason  jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'SCHEDULED'
                  CHECK (status IN ('SCHEDULED','ACCEPTED','COMPLETED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pairing_schedules_owner ON pairing_schedules (owner_id, status);

ALTER TABLE pairing_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY pairing_schedules_owner ON pairing_schedules USING (owner_id = app.uid());

CREATE TABLE onboarding_roadmaps (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  text REFERENCES projects(id) ON DELETE CASCADE,
  role        text NOT NULL,
  team        text NOT NULL,
  seniority   text NOT NULL
              CHECK (seniority IN ('JUNIOR','MID','SENIOR')),
  days        integer NOT NULL DEFAULT 5,
  tasks       jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_onboarding_roadmaps_owner ON onboarding_roadmaps (owner_id, created_at DESC);

ALTER TABLE onboarding_roadmaps ENABLE ROW LEVEL SECURITY;
CREATE POLICY onboarding_roadmaps_owner ON onboarding_roadmaps USING (owner_id = app.uid());

CREATE TABLE async_decisions (
  id              text PRIMARY KEY,
  owner_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id      text REFERENCES projects(id) ON DELETE CASCADE,
  title           text NOT NULL,
  description     text NOT NULL,
  options         jsonb NOT NULL DEFAULT '[]',
  evidence        jsonb NOT NULL DEFAULT '[]',
  voters          jsonb NOT NULL DEFAULT '[]',
  votes           jsonb NOT NULL DEFAULT '[]',
  dissents        jsonb NOT NULL DEFAULT '[]',
  status          text NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN ('OPEN','DECIDED','CLOSED')),
  resolved_option text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_async_decisions_owner ON async_decisions (owner_id, status);

ALTER TABLE async_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY async_decisions_owner ON async_decisions USING (owner_id = app.uid());