-- 0134_task_checkpoint_manifests.sql
-- Convergence migration: task_checkpoints name was split into two distinct
-- tables. 0049_stage26e_recovery.sql owns the recovery-shaped
-- `task_checkpoints` (attempt_id/stage_index/task_state/...), and
-- 0079_superpowers.sql owns the time-machine manifest table. Both feature
-- lines previously wrote to the SAME name with INCOMPATIBLE schemas, so a
-- fresh database aborted at 0079 and production carried only the recovery
-- shape while the superpowers module wrote superpowers-shape rows into it.
--
-- 0079 now creates `task_checkpoint_manifests` under its own name; this
-- migration makes production converge to the same layout without re-running
-- an already-applied migration. Idempotent: safe on both greenfield (the
-- table already exists from 0079) and any already-migrated database.
CREATE TABLE IF NOT EXISTS task_checkpoint_manifests (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id       text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id    text REFERENCES projects(id) ON DELETE CASCADE,
  label         text,
  manifest      jsonb NOT NULL DEFAULT '{}',
  forked_from   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_checkpoint_manifests_owner_task ON task_checkpoint_manifests (owner_id, task_id, created_at DESC);

ALTER TABLE task_checkpoint_manifests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS task_checkpoint_manifests_owner ON task_checkpoint_manifests;
CREATE POLICY task_checkpoint_manifests_owner ON task_checkpoint_manifests USING (owner_id = app.uid());