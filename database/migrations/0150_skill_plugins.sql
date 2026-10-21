-- 0150: Skill plugins — declarative bundles of skills (instructions) and slash
-- commands (prompt templates) a user installs, enables and disables.
-- Plugins are DATA ONLY: no code, no hooks, no new privileges. Built-in plugins
-- live in application code; this migration stores per-user custom manifests
-- and per-user install state. Owner-scoped RLS on both tables.

CREATE TABLE IF NOT EXISTS skill_plugin_packages (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug        text NOT NULL,
  version     text NOT NULL,
  manifest    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, slug)
);

CREATE TABLE IF NOT EXISTS skill_plugin_installs (
  id           text PRIMARY KEY,
  owner_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plugin_slug  text NOT NULL,
  version      text NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, plugin_slug)
);

CREATE INDEX IF NOT EXISTS idx_skill_plugin_installs_owner ON skill_plugin_installs (owner_id) WHERE enabled;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_skill_plugin_packages_updated_at') THEN
    CREATE TRIGGER trg_skill_plugin_packages_updated_at
      BEFORE UPDATE ON skill_plugin_packages
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_skill_plugin_installs_updated_at') THEN
    CREATE TRIGGER trg_skill_plugin_installs_updated_at
      BEFORE UPDATE ON skill_plugin_installs
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

ALTER TABLE skill_plugin_packages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS skill_plugin_packages_owner ON skill_plugin_packages;
CREATE POLICY skill_plugin_packages_owner ON skill_plugin_packages USING (owner_id = app.uid());

ALTER TABLE skill_plugin_installs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS skill_plugin_installs_owner ON skill_plugin_installs;
CREATE POLICY skill_plugin_installs_owner ON skill_plugin_installs USING (owner_id = app.uid());
