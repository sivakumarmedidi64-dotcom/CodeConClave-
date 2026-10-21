-- 0151: Team skill plugins — shared instructions (skills) and approved
-- workflow templates (slash commands) that a team owner/admin publishes.
-- Active for every ACTIVE member of the team. Every publish is kept as an
-- attributable version (spec: Team #4 versioned shared instructions, Team #11
-- versioned templates). Data only, like personal skill plugins.
-- Read access: team members (app.is_team_member). Writes are role-gated in
-- the service (OWNER/ADMIN) and additionally limited to members by RLS.

CREATE TABLE IF NOT EXISTS team_skill_plugins (
  id            text PRIMARY KEY,
  team_id       text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  slug          text NOT NULL,
  version       text NOT NULL,
  manifest      jsonb NOT NULL,
  published_by  text NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, slug)
);

CREATE TABLE IF NOT EXISTS team_skill_plugin_versions (
  id            text PRIMARY KEY,
  team_id       text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  slug          text NOT NULL,
  version       text NOT NULL,
  manifest      jsonb NOT NULL,
  action        text NOT NULL CHECK (action IN ('PUBLISHED','UNPUBLISHED')),
  actor_user_id text NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_skill_plugin_versions ON team_skill_plugin_versions (team_id, slug, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_team_skill_plugins_updated_at') THEN
    CREATE TRIGGER trg_team_skill_plugins_updated_at
      BEFORE UPDATE ON team_skill_plugins
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

ALTER TABLE team_skill_plugins ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS team_skill_plugins_member ON team_skill_plugins;
CREATE POLICY team_skill_plugins_member ON team_skill_plugins USING (app.is_team_member(team_id));

ALTER TABLE team_skill_plugin_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS team_skill_plugin_versions_member ON team_skill_plugin_versions;
CREATE POLICY team_skill_plugin_versions_member ON team_skill_plugin_versions USING (app.is_team_member(team_id));
