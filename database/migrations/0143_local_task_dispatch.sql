-- ---------------------------------------------------------------------------
-- 0143_local_task_dispatch.sql
-- P0 local execution fabric. Links a parked LOCAL task (WAITING_FOR_LOCAL_AGENT)
-- to a paired, online device through an attempt-scoped assignment lease
-- delivered over the existing /agent WebSocket. This is additive: no existing
-- column, status or index is altered, and offline semantics are unchanged —
-- a task remains WAITING_FOR_LOCAL_AGENT until a device CLAIMS the assignment.
--
-- Ownership is enforced twice: the app layer verifies the authenticated device
-- belongs to the task owner, and RLS binds row visibility to app.uid().
-- ---------------------------------------------------------------------------

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_device_id text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS local_assignment_at timestamptz;

CREATE TABLE IF NOT EXISTS local_task_assignments (
  id                text PRIMARY KEY,
  task_id           text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner_id          text NOT NULL,
  project_id        text NOT NULL,
  device_id         text NOT NULL,
  attempt_id        text,
  attempt_number    integer,
  status            text NOT NULL DEFAULT 'ASSIGNED',
  lease_expires_at  timestamptz NOT NULL,
  claimed_at        timestamptz,
  last_heartbeat_at timestamptz,
  completed_at      timestamptz,
  result            jsonb,
  error_code        text,
  error_detail      text,
  progress          jsonb,
  artifact_refs     jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT local_task_assignments_status_check CHECK (
    status IN ('ASSIGNED','CLAIMED','RUNNING','REPORTED','COMPLETED','FAILED','CANCELLED','EXPIRED')
  )
);

CREATE INDEX IF NOT EXISTS idx_local_task_assignments_task
  ON local_task_assignments (task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_local_task_assignments_device
  ON local_task_assignments (owner_id, device_id, status);
CREATE INDEX IF NOT EXISTS idx_local_task_assignments_lease
  ON local_task_assignments (status, lease_expires_at)
  WHERE status IN ('ASSIGNED','CLAIMED','RUNNING');

ALTER TABLE local_task_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS local_task_assignments_owner ON local_task_assignments;
CREATE POLICY local_task_assignments_owner ON local_task_assignments USING (owner_id = app.uid());
