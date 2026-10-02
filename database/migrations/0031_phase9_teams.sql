-- 0031: Phase 9 — Teams & collaboration: full team lifecycle, invitations,
-- member roles/status, shared resources (projects, conversations, memory),
-- team activity. Extends the Phase 4D-era teams/team_members tables in place.

-- ---------------------------------------------------------------------------
-- Teams: lifecycle metadata
-- ---------------------------------------------------------------------------
ALTER TABLE teams ADD COLUMN description text;
ALTER TABLE teams ADD COLUMN archived_at timestamptz;
ALTER TABLE teams ADD COLUMN settings jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX idx_teams_archived ON teams (archived_at);

-- ---------------------------------------------------------------------------
-- Team members: expanded role set + membership status
-- ---------------------------------------------------------------------------
ALTER TABLE team_members DROP CONSTRAINT team_members_role_check;
ALTER TABLE team_members ADD CONSTRAINT team_members_role_check
  CHECK (role IN ('owner','admin','editor','viewer','guest'));
ALTER TABLE team_members ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE'
  CHECK (status IN ('ACTIVE','SUSPENDED','REVOKED'));
ALTER TABLE team_members ADD COLUMN invited_by text REFERENCES users(id);
ALTER TABLE team_members ADD COLUMN joined_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE team_members ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX idx_team_members_status ON team_members (team_id, status);

-- ---------------------------------------------------------------------------
-- Team invitations: full invitation lifecycle
-- ---------------------------------------------------------------------------
CREATE TABLE team_invitations (
  id              text PRIMARY KEY,
  team_id         text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  invited_by      text NOT NULL REFERENCES users(id),
  invitee_user_id text NOT NULL REFERENCES users(id),
  invitee_email   text NOT NULL,
  role            text NOT NULL CHECK (role IN ('owner','admin','editor','viewer','guest')),
  state           text NOT NULL DEFAULT 'PENDING'
                  CHECK (state IN ('PENDING','ACCEPTED','REJECTED','EXPIRED','CANCELLED')),
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  rejected_at     timestamptz,
  cancelled_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_team_invitations_team ON team_invitations (team_id, state);
CREATE INDEX idx_team_invitations_invitee ON team_invitations (invitee_user_id, state);
CREATE INDEX idx_team_invitations_expiry ON team_invitations (state, expires_at);
CREATE UNIQUE INDEX uq_team_invitations_pending
  ON team_invitations (team_id, invitee_user_id) WHERE state = 'PENDING';

-- ---------------------------------------------------------------------------
-- Team activity: lightweight collaboration feed
-- ---------------------------------------------------------------------------
CREATE TABLE team_activity (
  id             text PRIMARY KEY,
  team_id        text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  actor_user_id  text NOT NULL REFERENCES users(id),
  action         text NOT NULL,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_team_activity_team ON team_activity (team_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Conversations: team-shared conversations
-- ---------------------------------------------------------------------------
ALTER TABLE conversations ADD COLUMN team_id text REFERENCES teams(id);
CREATE INDEX idx_conversations_team ON conversations (team_id);

-- ---------------------------------------------------------------------------
-- RLS: team-scoped policies layered over the existing tenant policies.
-- Service layer remains the enforcement authority; RLS mirrors it.
-- ---------------------------------------------------------------------------
CREATE POLICY teams_member_active ON teams
  USING (EXISTS (
    SELECT 1 FROM team_members tm
    WHERE tm.team_id = teams.id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
  ));

ALTER TABLE team_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY team_invitations_team_member ON team_invitations
  USING (EXISTS (
    SELECT 1 FROM team_members tm
    WHERE tm.team_id = team_invitations.team_id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
  ) OR invitee_user_id = app.uid());

ALTER TABLE team_activity ENABLE ROW LEVEL SECURITY;
CREATE POLICY team_activity_team_member ON team_activity
  USING (EXISTS (
    SELECT 1 FROM team_members tm
    WHERE tm.team_id = team_activity.team_id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
  ));

CREATE POLICY projects_team ON projects
  USING (team_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM team_members tm
    WHERE tm.team_id = projects.team_id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
  ));

CREATE POLICY conversations_team ON conversations
  USING (team_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM team_members tm
    WHERE tm.team_id = conversations.team_id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
  ));

CREATE POLICY messages_team ON messages
  USING (EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id AND c.team_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = c.team_id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
    )
  ));

CREATE POLICY threads_team ON threads
  USING (EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = threads.conversation_id AND c.team_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = c.team_id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
    )
  ));

CREATE POLICY reactions_team ON reactions
  USING (EXISTS (
    SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = reactions.message_id AND c.team_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = c.team_id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
    )
  ));

CREATE POLICY mentions_team ON mentions
  USING (EXISTS (
    SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = mentions.message_id AND c.team_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = c.team_id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
    )
  ));

CREATE POLICY memories_team ON memories
  USING (team_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM team_members tm
    WHERE tm.team_id = memories.team_id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
  ));

CREATE POLICY memory_sources_team ON memory_sources
  USING (EXISTS (
    SELECT 1 FROM memories m
    WHERE m.id = memory_sources.memory_id AND m.team_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = m.team_id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
    )
  ));

CREATE POLICY memory_relationships_team ON memory_relationships
  USING (EXISTS (
    SELECT 1 FROM memories m
    WHERE m.id = memory_relationships.source_memory_id AND m.team_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = m.team_id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
    )
  ));

CREATE POLICY files_team ON files
  USING (EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = files.project_id AND p.team_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = p.team_id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
    )
  ));

CREATE POLICY file_versions_team ON file_versions
  USING (EXISTS (
    SELECT 1 FROM files f JOIN projects p ON p.id = f.project_id
    WHERE f.id = file_versions.file_id AND p.team_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = p.team_id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
    )
  ));

CREATE POLICY file_permissions_team ON file_permissions
  USING (EXISTS (
    SELECT 1 FROM files f JOIN projects p ON p.id = f.project_id
    WHERE f.id = file_permissions.file_id AND p.team_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = p.team_id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
    )
  ));

CREATE POLICY file_references_team ON file_references
  USING (EXISTS (
    SELECT 1 FROM files f JOIN projects p ON p.id = f.project_id
    WHERE f.id = file_references.file_id AND p.team_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = p.team_id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
    )
  ));

CREATE POLICY tasks_team ON tasks
  USING (EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = tasks.project_id AND p.team_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = p.team_id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
    )
  ));

CREATE POLICY task_attempts_team ON task_attempts
  USING (EXISTS (
    SELECT 1 FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.id = task_attempts.task_id AND p.team_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = p.team_id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
    )
  ));

CREATE POLICY task_steps_team ON task_steps
  USING (EXISTS (
    SELECT 1 FROM task_attempts a JOIN tasks t ON t.id = a.task_id JOIN projects p ON p.id = t.project_id
    WHERE a.id = task_steps.attempt_id AND p.team_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = p.team_id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
    )
  ));

CREATE POLICY tool_calls_team ON tool_calls
  USING (EXISTS (
    SELECT 1 FROM task_steps s JOIN task_attempts a ON a.id = s.attempt_id
    JOIN tasks t ON t.id = a.task_id JOIN projects p ON p.id = t.project_id
    WHERE s.id = tool_calls.step_id AND p.team_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = p.team_id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
    )
  ));

CREATE POLICY artifacts_team ON artifacts
  USING (EXISTS (
    SELECT 1 FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.id = artifacts.task_id AND p.team_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = p.team_id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
    )
  ));

CREATE POLICY coworker_runs_team ON coworker_runs
  USING (EXISTS (
    SELECT 1 FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.id = coworker_runs.task_id AND p.team_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = p.team_id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
    )
  ));

CREATE POLICY coworker_handoffs_team ON coworker_handoffs
  USING (EXISTS (
    SELECT 1 FROM coworker_runs r JOIN tasks t ON t.id = r.task_id
    JOIN projects p ON p.id = t.project_id
    WHERE r.id = coworker_handoffs.from_run_id AND p.team_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = p.team_id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
    )
  ));

CREATE POLICY coworker_artifacts_team ON coworker_artifacts
  USING (EXISTS (
    SELECT 1 FROM coworker_runs r JOIN tasks t ON t.id = r.task_id
    JOIN projects p ON p.id = t.project_id
    WHERE r.id = coworker_artifacts.run_id AND p.team_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = p.team_id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
    )
  ));

CREATE POLICY dna_team_members ON dna
  USING (EXISTS (
    SELECT 1 FROM projects p JOIN team_members tm ON tm.team_id = p.team_id
    WHERE p.id = dna.project_id AND tm.user_id = app.uid() AND tm.status = 'ACTIVE'
  ));