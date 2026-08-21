-- 0040: RLS cycle fix (follow-up to 0039).
-- project_members_member's qual queried `projects`, whose projects_owner
-- policy queries project_members again -> policy cycle ("infinite recursion
-- detected in policy for relation"). All membership checks now resolve
-- through one SECURITY DEFINER helper that reads both tables owner-side.

CREATE OR REPLACE FUNCTION app.is_project_collaborator(p_project_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = p_project_id
      AND (p.owner_id = app.uid()
           OR EXISTS (
             SELECT 1 FROM project_members pm
             WHERE pm.project_id = p_project_id AND pm.user_id = app.uid()
           ))
  )
$$;

DROP POLICY IF EXISTS project_members_member ON project_members;
CREATE POLICY project_members_member ON project_members
  USING (app.is_project_collaborator(project_id));