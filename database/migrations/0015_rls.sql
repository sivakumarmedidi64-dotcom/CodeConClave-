-- 0015: Row-Level Security — tenant isolation for every tenant-scoped table.
-- Backend sets app.current_user_id (SET LOCAL, never client-supplied) per request.
-- Tables without RLS here (ai_model_registry, provider_health, events, feature_flags,
-- plugins catalogue) are service tables served only through read APIs.

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_self ON users
  USING (id = app.uid()) WITH CHECK (id = app.uid());

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY sessions_self ON sessions
  USING (user_id = app.uid()) WITH CHECK (user_id = app.uid());

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY devices_self ON devices
  USING (user_id = app.uid()) WITH CHECK (user_id = app.uid());

ALTER TABLE recovery_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY recovery_codes_self ON recovery_codes
  USING (user_id = app.uid()) WITH CHECK (user_id = app.uid());

-- ---------------------------------------------------------------------------
-- Collaboration
-- ---------------------------------------------------------------------------
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY teams_member ON teams
  USING (EXISTS (
    SELECT 1 FROM team_members tm WHERE tm.team_id = teams.id AND tm.user_id = app.uid()
  ));

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY team_members_member ON team_members
  USING (EXISTS (
    SELECT 1 FROM team_members tm WHERE tm.team_id = team_members.team_id AND tm.user_id = app.uid()
  ));

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY projects_owner ON projects
  USING (owner_id = app.uid() OR EXISTS (
    SELECT 1 FROM project_members pm WHERE pm.project_id = projects.id AND pm.user_id = app.uid()
  ))
  WITH CHECK (owner_id = app.uid());

ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_members_member ON project_members
  USING (project_id IN (
    SELECT id FROM projects WHERE owner_id = app.uid() OR id IN (
      SELECT project_id FROM project_members WHERE user_id = app.uid()
    )
  ));

-- ---------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversations_owner ON conversations
  USING (owner_id = app.uid()) WITH CHECK (owner_id = app.uid());

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY messages_owner ON messages
  USING (EXISTS (
    SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id AND c.owner_id = app.uid()
  ));

ALTER TABLE threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY threads_owner ON threads
  USING (EXISTS (
    SELECT 1 FROM conversations c WHERE c.id = threads.conversation_id AND c.owner_id = app.uid()
  ));

ALTER TABLE reactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY reactions_owner ON reactions
  USING (EXISTS (
    SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = reactions.message_id AND c.owner_id = app.uid()
  ));

ALTER TABLE mentions ENABLE ROW LEVEL SECURITY;
CREATE POLICY mentions_owner ON mentions
  USING (EXISTS (
    SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = mentions.message_id AND c.owner_id = app.uid()
  ));

-- ---------------------------------------------------------------------------
-- Memory
-- ---------------------------------------------------------------------------
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
CREATE POLICY memories_owner ON memories
  USING (owner_id = app.uid() OR (
    project_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM project_members pm WHERE pm.project_id = memories.project_id AND pm.user_id = app.uid()
    )
  ))
  WITH CHECK (owner_id = app.uid());

ALTER TABLE memory_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_sources_owner ON memory_sources
  USING (EXISTS (
    SELECT 1 FROM memories m WHERE m.id = memory_sources.memory_id
    AND (m.owner_id = app.uid() OR (m.project_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM project_members pm WHERE pm.project_id = m.project_id AND pm.user_id = app.uid()
    )))
  ));

ALTER TABLE memory_relationships ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_relationships_owner ON memory_relationships
  USING (EXISTS (
    SELECT 1 FROM memories m WHERE m.id = memory_relationships.source_memory_id
    AND (m.owner_id = app.uid() OR (m.project_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM project_members pm WHERE pm.project_id = m.project_id AND pm.user_id = app.uid()
    )))
  ));

-- ---------------------------------------------------------------------------
-- DNA
-- ---------------------------------------------------------------------------
ALTER TABLE dna ENABLE ROW LEVEL SECURITY;
CREATE POLICY dna_owner ON dna
  USING (owner_id = app.uid() OR EXISTS (
    SELECT 1 FROM project_members pm WHERE pm.project_id = dna.project_id AND pm.user_id = app.uid()
  ))
  WITH CHECK (owner_id = app.uid());

ALTER TABLE dna_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY dna_versions_owner ON dna_versions
  USING (EXISTS (
    SELECT 1 FROM dna d WHERE d.id = dna_versions.dna_id
    AND (d.owner_id = app.uid() OR EXISTS (
      SELECT 1 FROM project_members pm WHERE pm.project_id = d.project_id AND pm.user_id = app.uid()
    ))
  ));

ALTER TABLE dna_conflicts ENABLE ROW LEVEL SECURITY;
CREATE POLICY dna_conflicts_owner ON dna_conflicts
  USING (EXISTS (
    SELECT 1 FROM dna d WHERE d.id = dna_conflicts.branch_dna_id
    AND (d.owner_id = app.uid() OR EXISTS (
      SELECT 1 FROM project_members pm WHERE pm.project_id = d.project_id AND pm.user_id = app.uid()
    ))
  ));

-- ---------------------------------------------------------------------------
-- Files
-- ---------------------------------------------------------------------------
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
CREATE POLICY files_owner ON files
  USING (owner_id = app.uid() OR EXISTS (
    SELECT 1 FROM project_members pm WHERE pm.project_id = files.project_id AND pm.user_id = app.uid()
  ))
  WITH CHECK (owner_id = app.uid());

ALTER TABLE file_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY file_versions_owner ON file_versions
  USING (EXISTS (
    SELECT 1 FROM files f WHERE f.id = file_versions.file_id
    AND (f.owner_id = app.uid() OR EXISTS (
      SELECT 1 FROM project_members pm WHERE pm.project_id = f.project_id AND pm.user_id = app.uid()
    ))
  ));

ALTER TABLE file_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY file_permissions_owner ON file_permissions
  USING (EXISTS (
    SELECT 1 FROM files f WHERE f.id = file_permissions.file_id
    AND (f.owner_id = app.uid() OR EXISTS (
      SELECT 1 FROM project_members pm WHERE pm.project_id = f.project_id AND pm.user_id = app.uid()
    ))
  ));

ALTER TABLE file_references ENABLE ROW LEVEL SECURITY;
CREATE POLICY file_references_owner ON file_references
  USING (EXISTS (
    SELECT 1 FROM files f WHERE f.id = file_references.file_id
    AND (f.owner_id = app.uid() OR EXISTS (
      SELECT 1 FROM project_members pm WHERE pm.project_id = f.project_id AND pm.user_id = app.uid()
    ))
  ));

-- ---------------------------------------------------------------------------
-- Execution
-- ---------------------------------------------------------------------------
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tasks_owner ON tasks
  USING (owner_id = app.uid() OR EXISTS (
    SELECT 1 FROM project_members pm WHERE pm.project_id = tasks.project_id AND pm.user_id = app.uid()
  ))
  WITH CHECK (owner_id = app.uid());

ALTER TABLE task_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_attempts_owner ON task_attempts
  USING (EXISTS (
    SELECT 1 FROM tasks t WHERE t.id = task_attempts.task_id
    AND (t.owner_id = app.uid() OR EXISTS (
      SELECT 1 FROM project_members pm WHERE pm.project_id = t.project_id AND pm.user_id = app.uid()
    ))
  ));

ALTER TABLE task_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_steps_owner ON task_steps
  USING (EXISTS (
    SELECT 1 FROM tasks t WHERE t.id = task_steps.task_id
    AND (t.owner_id = app.uid() OR EXISTS (
      SELECT 1 FROM project_members pm WHERE pm.project_id = t.project_id AND pm.user_id = app.uid()
    ))
  ));

ALTER TABLE tool_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY tool_calls_owner ON tool_calls
  USING (EXISTS (
    SELECT 1 FROM tasks t WHERE t.id = tool_calls.task_id
    AND (t.owner_id = app.uid() OR EXISTS (
      SELECT 1 FROM project_members pm WHERE pm.project_id = t.project_id AND pm.user_id = app.uid()
    ))
  ));

-- approvals: users may read approvals they own; inserts happen server-side.
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY approvals_owner ON approvals
  USING (owner_id = app.uid()) WITH CHECK (true);

ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY artifacts_owner ON artifacts
  USING (EXISTS (
    SELECT 1 FROM tasks t WHERE t.id = artifacts.task_id
    AND (t.owner_id = app.uid() OR EXISTS (
      SELECT 1 FROM project_members pm WHERE pm.project_id = t.project_id AND pm.user_id = app.uid()
    ))
  ));

-- ---------------------------------------------------------------------------
-- Coworkers
-- ---------------------------------------------------------------------------
ALTER TABLE coworker_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY coworker_runs_owner ON coworker_runs
  USING (EXISTS (
    SELECT 1 FROM tasks t WHERE t.id = coworker_runs.task_id
    AND (t.owner_id = app.uid() OR EXISTS (
      SELECT 1 FROM project_members pm WHERE pm.project_id = t.project_id AND pm.user_id = app.uid()
    ))
  ));

ALTER TABLE coworker_handoffs ENABLE ROW LEVEL SECURITY;
CREATE POLICY coworker_handoffs_owner ON coworker_handoffs
  USING (EXISTS (
    SELECT 1 FROM coworker_runs cr JOIN tasks t ON t.id = cr.task_id
    WHERE cr.id = coworker_handoffs.from_run_id
    AND (t.owner_id = app.uid() OR EXISTS (
      SELECT 1 FROM project_members pm WHERE pm.project_id = t.project_id AND pm.user_id = app.uid()
    ))
  ));

ALTER TABLE coworker_artifacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY coworker_artifacts_owner ON coworker_artifacts
  USING (EXISTS (
    SELECT 1 FROM coworker_runs cr JOIN tasks t ON t.id = cr.task_id
    WHERE cr.id = coworker_artifacts.run_id
    AND (t.owner_id = app.uid() OR EXISTS (
      SELECT 1 FROM project_members pm WHERE pm.project_id = t.project_id AND pm.user_id = app.uid()
    ))
  ));

-- ---------------------------------------------------------------------------
-- Payments / entitlements
-- ---------------------------------------------------------------------------
ALTER TABLE payment_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_sessions_owner ON payment_sessions
  USING (user_id = app.uid()) WITH CHECK (true);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY payments_owner ON payments
  USING (EXISTS (
    SELECT 1 FROM payment_sessions ps WHERE ps.id = payments.session_id AND ps.user_id = app.uid()
  ));

ALTER TABLE entitlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY entitlements_owner ON entitlements
  USING (user_id = app.uid()) WITH CHECK (true);

ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_events_owner ON payment_events
  USING (user_id = app.uid() OR EXISTS (
    SELECT 1 FROM payment_sessions ps WHERE ps.id = payment_events.session_id AND ps.user_id = app.uid()
  ));

-- payment_audit: append-only; backend service writes, users read own sessions.
ALTER TABLE payment_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_audit_owner ON payment_audit
  USING (EXISTS (
    SELECT 1 FROM payment_sessions ps WHERE ps.id = payment_audit.session_id AND ps.user_id = app.uid()
  )) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Plugins / workspace / usage
-- ---------------------------------------------------------------------------
ALTER TABLE plugin_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY plugin_connections_owner ON plugin_connections
  USING (owner_id = app.uid()) WITH CHECK (owner_id = app.uid());

ALTER TABLE plugin_scopes ENABLE ROW LEVEL SECURITY;
CREATE POLICY plugin_scopes_owner ON plugin_scopes
  USING (EXISTS (
    SELECT 1 FROM plugin_connections pc WHERE pc.id = plugin_scopes.connection_id AND pc.owner_id = app.uid()
  ));

ALTER TABLE plugin_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY plugin_events_owner ON plugin_events
  USING (EXISTS (
    SELECT 1 FROM plugin_connections pc WHERE pc.id = plugin_events.connection_id AND pc.owner_id = app.uid()
  ));

ALTER TABLE workspace_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_state_owner ON workspace_state
  USING (owner_id = app.uid()) WITH CHECK (owner_id = app.uid());

ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_preferences_owner ON user_preferences
  USING (owner_id = app.uid()) WITH CHECK (owner_id = app.uid());

ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY usage_counters_owner ON usage_counters
  USING (owner_id = app.uid()) WITH CHECK (owner_id = app.uid());

-- ---------------------------------------------------------------------------
-- Audit / outbox (service tables; append-only in code)
-- ---------------------------------------------------------------------------
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_read ON audit_logs
  USING (actor_user_id = app.uid()) WITH CHECK (true);