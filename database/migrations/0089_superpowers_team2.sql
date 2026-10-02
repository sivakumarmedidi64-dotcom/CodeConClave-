-- ---------------------------------------------------------------------------
-- CodeConClave — Superpowers (Tranche K): team & organization scale 2.
--
--   KNOWLEDGE HANDOFF       (feature 135): one click generates a leaver's
--                           "brain export" — everything they touched, every
--                           decision, every correction pattern — ready for a
--                           replacement.
--   REVIEW LOAD BALANCER    (feature 137): PR reviews distributed by expertise,
--                           availability and past review quality so nobody
--                           drowns in reviews.
--   PERFORMANCE REVIEW DATA (feature 141): 360 feedback derived from real git
--                           + review activity — evidence, not vibes.
--   BUDGET TRANSPARENCY     (feature 144): every team's compute spend visible
--                           and attributed to tasks.
--   EQUITY METRICS          (feature 147): contribution equity — who reviewed,
--                           tested, ran ops — often-invisible work made
--                           visible.
--
-- Owned rows + RLS identical to 0079..0088 (app.uid() scoping).
-- ---------------------------------------------------------------------------

CREATE TABLE knowledge_exports (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person      text NOT NULL,
  scope       text NOT NULL DEFAULT 'FULL'
              CHECK (scope IN ('FULL','ESSENTIAL')),
  modules     jsonb NOT NULL DEFAULT '[]',
  decisions   jsonb NOT NULL DEFAULT '[]',
  corrections jsonb NOT NULL DEFAULT '[]',
  digest      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_knowledge_exports_owner ON knowledge_exports (owner_id, created_at DESC);

ALTER TABLE knowledge_exports ENABLE ROW LEVEL SECURITY;
CREATE POLICY knowledge_exports_owner ON knowledge_exports USING (owner_id = app.uid());

CREATE TABLE review_load_plans (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  text REFERENCES projects(id) ON DELETE CASCADE,
  item_count  integer NOT NULL DEFAULT 0,
  assigned    integer NOT NULL DEFAULT 0,
  plan        jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_review_load_plans_owner ON review_load_plans (owner_id, created_at DESC);

ALTER TABLE review_load_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY review_load_plans_owner ON review_load_plans USING (owner_id = app.uid());

CREATE TABLE performance_digests (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person      text NOT NULL,
  period      text NOT NULL,
  metrics     jsonb NOT NULL DEFAULT '{}',
  score       integer NOT NULL DEFAULT 0,
  tier        text NOT NULL,
  narrative   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_performance_digests_owner ON performance_digests (owner_id, person);

ALTER TABLE performance_digests ENABLE ROW LEVEL SECURITY;
CREATE POLICY performance_digests_owner ON performance_digests USING (owner_id = app.uid());

CREATE TABLE team_cost_attributions (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team        text NOT NULL,
  period      text NOT NULL,
  task        text NOT NULL,
  resource    text NOT NULL,
  cost_usd    numeric NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  share       numeric NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_team_cost_attributions_owner ON team_cost_attributions (owner_id, team);

ALTER TABLE team_cost_attributions ENABLE ROW LEVEL SECURITY;
CREATE POLICY team_cost_attributions_owner ON team_cost_attributions USING (owner_id = app.uid());

CREATE TABLE equity_scores (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period            text NOT NULL,
  name              text NOT NULL,
  visible           integer NOT NULL DEFAULT 0,
  invisible         integer NOT NULL DEFAULT 0,
  invisible_share   numeric NOT NULL DEFAULT 0,
  tier              text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_equity_scores_owner ON equity_scores (owner_id, period);

ALTER TABLE equity_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY equity_scores_owner ON equity_scores USING (owner_id = app.uid());