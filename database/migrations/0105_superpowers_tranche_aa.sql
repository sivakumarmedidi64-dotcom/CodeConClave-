-- CodeConClave — Stage 0105 SUPERPOWERS Tranche AA (Respawn State Matrix, Pixel Diff Judge, Motion Doctor, A11Y Autopilot, Localization Forge)

-- RESPAWN STATE MATRIX — every component auto-tested in all 16 states
CREATE TABLE IF NOT EXISTS state_matrix_runs (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  component     TEXT NOT NULL,
  states_tested JSONB NOT NULL DEFAULT '[]'::jsonb,
  passed        INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  failures      JSONB NOT NULL DEFAULT '[]'::jsonb,
  status        TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','PASSED','FAILED')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE state_matrix_runs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'state_matrix_runs_owner' AND tablename = 'state_matrix_runs') THEN CREATE POLICY state_matrix_runs_owner ON state_matrix_runs USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_state_matrix_runs_owner ON state_matrix_runs(owner_id);

-- PIXEL DIFF JUDGE — visual regression testing with semantic understanding
CREATE TABLE IF NOT EXISTS pixel_diffs (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  baseline_url         TEXT NOT NULL,
  current_url          TEXT NOT NULL,
  total_pixels_changed INTEGER NOT NULL DEFAULT 0,
  layout_breaking      BOOLEAN NOT NULL DEFAULT false,
  semantic_change      BOOLEAN NOT NULL DEFAULT false,
  threshold_px         INTEGER NOT NULL DEFAULT 2,
  verdict              TEXT NOT NULL DEFAULT 'CLEAN' CHECK (verdict IN ('CLEAN','WARNING','BREAKING')),
  diff_regions         JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE pixel_diffs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'pixel_diffs_owner' AND tablename = 'pixel_diffs') THEN CREATE POLICY pixel_diffs_owner ON pixel_diffs USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_pixel_diffs_owner ON pixel_diffs(owner_id);

-- MOTION DOCTOR — every animation audited for performance and accessibility
CREATE TABLE IF NOT EXISTS motion_audits (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  component        TEXT NOT NULL,
  animation_name   TEXT NOT NULL,
  fps              NUMERIC NOT NULL DEFAULT 0,
  duration_ms      NUMERIC NOT NULL DEFAULT 0,
  issues           JSONB NOT NULL DEFAULT '[]'::jsonb,
  overall_severity TEXT NOT NULL DEFAULT 'NONE' CHECK (overall_severity IN ('NONE','LOW','MEDIUM','HIGH')),
  status           TEXT NOT NULL DEFAULT 'AUDITED' CHECK (status IN ('AUDITED','FLAGGED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE motion_audits ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'motion_audits_owner' AND tablename = 'motion_audits') THEN CREATE POLICY motion_audits_owner ON motion_audits USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_motion_audits_owner ON motion_audits(owner_id);

-- A11Y AUTOPILOT — screen-reader bot navigates app with keyboard and voice
CREATE TABLE IF NOT EXISTS a11y_runs (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  target_url       TEXT NOT NULL,
  pages_scanned    INTEGER NOT NULL DEFAULT 0,
  navigation_path  JSONB NOT NULL DEFAULT '[]'::jsonb,
  issues           JSONB NOT NULL DEFAULT '[]'::jsonb,
  issue_count      INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'NAVIGATING' CHECK (status IN ('NAVIGATING','COMPLETED','BLOCKED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE a11y_runs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'a11y_runs_owner' AND tablename = 'a11y_runs') THEN CREATE POLICY a11y_runs_owner ON a11y_runs USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_a11y_runs_owner ON a11y_runs(owner_id);

-- LOCALIZATION FORGE — extracts all strings, manages translation state, detects issues
CREATE TABLE IF NOT EXISTS localization_scans (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  project          TEXT NOT NULL,
  locales          JSONB NOT NULL DEFAULT '[]'::jsonb,
  strings_scanned  INTEGER NOT NULL DEFAULT 0,
  issues           JSONB NOT NULL DEFAULT '[]'::jsonb,
  issue_count      INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'SCANNING' CHECK (status IN ('SCANNING','COMPLETED','HAS_ISSUES')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE localization_scans ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'localization_scans_owner' AND tablename = 'localization_scans') THEN CREATE POLICY localization_scans_owner ON localization_scans USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_localization_scans_owner ON localization_scans(owner_id);
