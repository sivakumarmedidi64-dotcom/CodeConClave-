-- 0035: PHASE 13 — cleanup recommendations + history stars.
-- Persisted, deterministic cleanup candidates and per-user history starring.

-- ---------------------------------------------------------------------------
-- cleanup_recommendations: real candidates derived from database queries
-- (expired trash, duplicate files, old artifacts, stale versions, expired
-- notifications). Each row carries the reason, measurable storage impact,
-- affected resources, reversibility classification and the authorization
-- level required to act. Nothing is auto-deleted — the user decides.
-- ---------------------------------------------------------------------------

CREATE TABLE cleanup_recommendations (
  id                   text PRIMARY KEY,
  owner_id             text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  candidate_type       text NOT NULL,
  reason               text NOT NULL,
  storage_impact_bytes bigint NOT NULL DEFAULT 0,
  affected             jsonb NOT NULL DEFAULT '[]'::jsonb,
  reversible           boolean NOT NULL DEFAULT false,
  authorization_level  text NOT NULL DEFAULT 'owner',
  status               text NOT NULL DEFAULT 'ACTIVE'
                       CHECK (status IN ('ACTIVE','RESOLVED','DISMISSED')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  resolved_at          timestamptz
);

CREATE INDEX idx_cleanup_recommendations_owner ON cleanup_recommendations (owner_id, status);

ALTER TABLE cleanup_recommendations ENABLE ROW LEVEL SECURITY;

CREATE POLICY cleanup_recommendations_owner ON cleanup_recommendations
  USING (owner_id = app.uid());

-- ---------------------------------------------------------------------------
-- history_stars: user-level stars over unified History events. Events are
-- identified by (source, event_id) where source is one of audit /
-- project_activity / file_activity / team_activity and event_id is the id in
-- that source table. No new event rows are created — this only marks existing
-- persisted events.
-- ---------------------------------------------------------------------------

CREATE TABLE history_stars (
  id         text PRIMARY KEY,
  owner_id   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source     text NOT NULL,
  event_id   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_history_stars UNIQUE (owner_id, source, event_id)
);

CREATE INDEX idx_history_stars_owner ON history_stars (owner_id, created_at DESC);

ALTER TABLE history_stars ENABLE ROW LEVEL SECURITY;

CREATE POLICY history_stars_owner ON history_stars
  USING (owner_id = app.uid());