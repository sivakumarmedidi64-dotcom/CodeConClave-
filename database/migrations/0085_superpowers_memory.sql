-- ---------------------------------------------------------------------------
-- CodeConClave — Superpowers (Tranche G): memory, learning & history cluster.
--
--   BLAMELESS ARCHIVIST   (feature 48): every incident archived as the full
--                          story — timeline + cause + fix + prevention — and
--                          retrieved automatically when a similar issue is
--                          worked later.
--   ONTOLOGY ENGINE       (feature 50): a living dictionary of domain terms;
--                          divergence scans flag aliases used in place of the
--                          canonical name, and corrections propagate on
--                          agreement.
--   VOICE-OF-CODEBASE     (feature 52): the codebase answers questions
--                          conversationally, backed by evidence pulled from
--                          stored memory (postmortems, ontology, skills).
--   COMMIT ARCHAEOLOGIST  (feature 56): origin records reconstruct the moment
--                          a function was written — commit, author, PR summary,
--                          context — so inherited code explains itself.
--   SKILL TAXONOMY        (feature 58): every commit/review/correction emits a
--                          weight-bearing skill signal; "who knows X best" is
--                          answered from data, not tribal memory.
--
-- Owned rows + RLS identical to 0079..0084 (app.uid() scoping).
-- ---------------------------------------------------------------------------

CREATE TABLE postmortems (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  incident_id       text,
  title             text NOT NULL,
  summary           text NOT NULL,
  timeline          text,
  root_cause        text NOT NULL,
  fix               text NOT NULL,
  prevention        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, incident_id)
);

CREATE INDEX idx_postmortems_owner ON postmortems (owner_id, created_at DESC);

ALTER TABLE postmortems ENABLE ROW LEVEL SECURITY;
CREATE POLICY postmortems_owner ON postmortems USING (owner_id = app.uid());

CREATE TABLE ontology_terms (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  canonical_name    text NOT NULL,
  aliases           jsonb NOT NULL DEFAULT '[]',
  definition        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, canonical_name)
);

ALTER TABLE ontology_terms ENABLE ROW LEVEL SECURITY;
CREATE POLICY ontology_terms_owner ON ontology_terms USING (owner_id = app.uid());

CREATE TABLE ontology_violations (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  term_id           text NOT NULL REFERENCES ontology_terms(id) ON DELETE CASCADE,
  source_type       text NOT NULL
                    CHECK (source_type IN ('CODE','DOCS','API','UI_COPY')),
  location          text NOT NULL,
  used_term         text NOT NULL,
  status            text NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN','APPROVED','REJECTED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ontology_violations_owner ON ontology_violations (owner_id, status);

ALTER TABLE ontology_violations ENABLE ROW LEVEL SECURITY;
CREATE POLICY ontology_violations_owner ON ontology_violations USING (owner_id = app.uid());

CREATE TABLE codebase_answers (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question          text NOT NULL,
  answer            text NOT NULL,
  evidence_sources  jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_codebase_answers_owner ON codebase_answers (owner_id, created_at DESC);

ALTER TABLE codebase_answers ENABLE ROW LEVEL SECURITY;
CREATE POLICY codebase_answers_owner ON codebase_answers USING (owner_id = app.uid());

CREATE TABLE file_origin_insights (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  file_path         text NOT NULL,
  function_name     text NOT NULL,
  first_seen_commit text NOT NULL,
  first_seen_date   timestamptz,
  author            text NOT NULL,
  pr_summary        text,
  context           text,
  depth             integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, file_path, function_name)
);

CREATE INDEX idx_file_origin_insights_owner ON file_origin_insights (owner_id, file_path);

ALTER TABLE file_origin_insights ENABLE ROW LEVEL SECURITY;
CREATE POLICY file_origin_insights_owner ON file_origin_insights USING (owner_id = app.uid());

CREATE TABLE skill_signals (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  developer         text NOT NULL,
  skill             text NOT NULL,
  domain            text NOT NULL DEFAULT 'GENERAL',
  weight            integer NOT NULL DEFAULT 1,
  source            text NOT NULL
                    CHECK (source IN ('COMMIT','REVIEW','CORRECTION')),
  evidence_ref      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, developer, skill, source)
);

CREATE INDEX idx_skill_signals_owner ON skill_signals (owner_id, skill);

ALTER TABLE skill_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY skill_signals_owner ON skill_signals USING (owner_id = app.uid());