-- ---------------------------------------------------------------------------
-- CodeConClave — Superpowers (Tranche C): FRESH-EYES REVIEW (feature 11).
--
-- An agent with ZERO project context reviews code like an outside contractor:
-- blind to team conventions, blind to normalized technical debt. This table
-- stores those outside-perspective reviews. Every review runs deterministic
-- blind-spot analyzers (magic numbers, TODO/FIXME debt, suspected secrets,
-- swallowed errors, duplicated literals, leftover console logging) that flag
-- exactly the things context-rich agents learned to ignore. Each flagged item
-- carries evidence + why + a concrete suggestion. A proof claim can be linked
-- so the finding is provable, not asserted. Reviews close honestly.
--
-- Owned rows + RLS identical to the other superpowers tables.
-- ---------------------------------------------------------------------------

CREATE TABLE fresh_eyes_reviews (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    text REFERENCES projects(id) ON DELETE CASCADE,
  task_id       text,
  file          text,
  input         text NOT NULL,               -- the code / diff that was reviewed
  findings      jsonb NOT NULL DEFAULT '[]', -- [ { rule, evidence, why, suggestion } ]
  verdict       text NOT NULL
                CHECK (verdict IN ('CLEAN', 'FLAGGED')),
  outside_perspective text NOT NULL,         -- blind-spot prose (deterministic)
  inside_perspective  text,                  -- the context-rich pair view / note
  proof_claim_id text REFERENCES proof_claims(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'OPEN'
                CHECK (status IN ('OPEN', 'RESOLVED', 'DISMISSED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fresh_eyes_owner ON fresh_eyes_reviews (owner_id, status, created_at DESC);

ALTER TABLE fresh_eyes_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY fresh_eyes_reviews_owner ON fresh_eyes_reviews USING (owner_id = app.uid());