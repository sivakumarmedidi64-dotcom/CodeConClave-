-- 0153: Organization-wide execution policies (spec Team #14).
-- Same shape as control_policies but owned by a team. Enforced by
-- evaluatePolicy for work done in the team's context (tasks in team
-- projects) in addition to the member's personal policies. Policies only
-- tighten (require approval / block); they never grant a capability.
-- Read: team members. Writes: owner/admin, gated in the service.

CREATE TABLE IF NOT EXISTS team_control_policies (
  id          text PRIMARY KEY,
  team_id     text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  scope       text NOT NULL,
  action      text NOT NULL,
  risk_level  text NOT NULL,
  requirement text NOT NULL CHECK (requirement IN ('require_approval','block')),
  enabled     boolean NOT NULL DEFAULT true,
  created_by  text NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, scope, action)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_team_control_policies_updated_at') THEN
    CREATE TRIGGER trg_team_control_policies_updated_at
      BEFORE UPDATE ON team_control_policies
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

ALTER TABLE team_control_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS team_control_policies_member ON team_control_policies;
CREATE POLICY team_control_policies_member ON team_control_policies USING (app.is_team_member(team_id));
