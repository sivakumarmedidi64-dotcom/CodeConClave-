-- 0162: "Beyond agentic" systems (constitution Part VI). Everything here is
-- measured from the user's real project files; nothing is estimated or faked.
--   code_temperature_snapshots  Code Thermostat history (0-100 + the parts it is made of)
--   immunity_vaccines           Immunity: patterns of bugs the user fixed once, checked everywhere
--   night_shift_reports         Night Shift: the nightly measure-and-report run (never edits code)

CREATE TABLE IF NOT EXISTS code_temperature_snapshots (
  id              text PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id      text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  temperature     integer NOT NULL CHECK (temperature BETWEEN 0 AND 100),
  level           text NOT NULL CHECK (level IN ('COOL','WARM','HOT','CRITICAL')),
  components      jsonb NOT NULL,
  hottest         jsonb NOT NULL DEFAULT '[]'::jsonb,
  files_measured  integer NOT NULL DEFAULT 0,
  lines_measured  integer NOT NULL DEFAULT 0,
  source          text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','night_shift')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_code_temperature_project ON code_temperature_snapshots (user_id, project_id, created_at DESC);
ALTER TABLE code_temperature_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS code_temperature_self ON code_temperature_snapshots;
CREATE POLICY code_temperature_self ON code_temperature_snapshots USING (user_id = app.uid());

CREATE TABLE IF NOT EXISTS immunity_vaccines (
  id                text PRIMARY KEY,
  user_id           text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  pattern           text NOT NULL CHECK (length(pattern) BETWEEN 1 AND 300),
  kind              text NOT NULL CHECK (kind IN ('literal','regex')),
  file_glob         text CHECK (file_glob IS NULL OR length(file_glob) <= 120),
  fix_note          text CHECK (fix_note IS NULL OR length(fix_note) <= 500),
  severity          text NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  last_scan_at      timestamptz,
  last_match_count  integer NOT NULL DEFAULT 0,
  last_matches      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_immunity_vaccines_user ON immunity_vaccines (user_id, created_at);
ALTER TABLE immunity_vaccines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS immunity_vaccines_self ON immunity_vaccines;
CREATE POLICY immunity_vaccines_self ON immunity_vaccines USING (user_id = app.uid());

CREATE TABLE IF NOT EXISTS night_shift_reports (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trigger      text NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual','schedule')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  summary      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_night_shift_user ON night_shift_reports (user_id, started_at DESC);
ALTER TABLE night_shift_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS night_shift_self ON night_shift_reports;
CREATE POLICY night_shift_self ON night_shift_reports USING (user_id = app.uid());
