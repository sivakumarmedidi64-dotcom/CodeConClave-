-- 0039: RLS recursion fix.
-- Self-referential membership policies caused PostgreSQL's
-- "infinite recursion detected in policy for relation" error at query time
-- for any non-owner access. SECURITY DEFINER helpers read membership tables
-- with RLS bypassed (owner context) so policies never re-enter themselves;
-- policy semantics are identical (same rows visible / same writes allowed).

CREATE OR REPLACE FUNCTION app.is_team_member(p_team_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM team_members tm
    WHERE tm.team_id = p_team_id AND tm.user_id = app.uid()
  )
$$;

CREATE OR REPLACE FUNCTION app.is_project_member(p_project_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM project_members pm
    WHERE pm.project_id = p_project_id AND pm.user_id = app.uid()
  )
$$;

CREATE OR REPLACE FUNCTION app.is_session_participant(p_session_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM brainstorming_participants bp
    WHERE bp.session_id = p_session_id AND bp.user_id = app.uid()
  )
$$;

DROP POLICY IF EXISTS team_members_member ON team_members;
CREATE POLICY team_members_member ON team_members
  USING (app.is_team_member(team_id));

DROP POLICY IF EXISTS project_members_member ON project_members;
CREATE POLICY project_members_member ON project_members
  USING (EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = project_members.project_id
      AND (p.owner_id = app.uid() OR app.is_project_member(p.id))
  ));

DROP POLICY IF EXISTS brainstorm_participants_session ON brainstorming_participants;
CREATE POLICY brainstorm_participants_session ON brainstorming_participants
  USING (app.is_session_participant(session_id));