-- 0037: Phase 15 — Row-Level Security for tenant-scoped tables created after
-- 0015 (memory_corrections, task_dependencies, task_dlq, plans, plan_entries).
-- These tables reference tenant-scoped parents (memories / tasks / projects)
-- and were created without RLS policies. Users may read only rows reachable
-- through their own memories, tasks, or project membership; writes are
-- backend-service only (service role), matching the model_usage_logs pattern
-- (WITH CHECK (false)). No duplicate tables; no changes to existing policies.
-- NOTE: this repo validates migrations statically only (no live PostgreSQL).

-- memory_corrections — append-only provenance trail for memory operations.
ALTER TABLE memory_corrections ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_corrections_owner ON memory_corrections
  USING (EXISTS (
    SELECT 1 FROM memories m
    WHERE m.id = memory_corrections.memory_id
      AND (m.owner_id = app.uid() OR (m.project_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM project_members pm WHERE pm.project_id = m.project_id AND pm.user_id = app.uid()
      )))
  )) WITH CHECK (false);

-- task_dependencies — edges between tasks owned by the user or their projects.
ALTER TABLE task_dependencies ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_dependencies_owner ON task_dependencies
  USING (EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.id = task_dependencies.task_id
      AND (t.owner_id = app.uid() OR EXISTS (
        SELECT 1 FROM project_members pm WHERE pm.project_id = t.project_id AND pm.user_id = app.uid()
      ))
  )) WITH CHECK (false);

-- task_dlq — dead-lettered tasks carry owner_id + project_id directly.
ALTER TABLE task_dlq ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_dlq_owner ON task_dlq
  USING (owner_id = app.uid() OR EXISTS (
    SELECT 1 FROM project_members pm WHERE pm.project_id = task_dlq.project_id AND pm.user_id = app.uid()
  )) WITH CHECK (false);

-- plans — persisted Planner output, scoped via the owning task.
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY plans_owner ON plans
  USING (EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.id = plans.task_id
      AND (t.owner_id = app.uid() OR EXISTS (
        SELECT 1 FROM project_members pm WHERE pm.project_id = t.project_id AND pm.user_id = app.uid()
      ))
  )) WITH CHECK (false);

-- plan_entries — entries of a plan, scoped via plan → task.
ALTER TABLE plan_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY plan_entries_owner ON plan_entries
  USING (EXISTS (
    SELECT 1 FROM plans p JOIN tasks t ON t.id = p.task_id
    WHERE p.id = plan_entries.plan_id
      AND (t.owner_id = app.uid() OR EXISTS (
        SELECT 1 FROM project_members pm WHERE pm.project_id = t.project_id AND pm.user_id = app.uid()
      ))
  )) WITH CHECK (false);