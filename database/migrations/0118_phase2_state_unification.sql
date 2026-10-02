-- ---------------------------------------------------------------------------
-- CodeConClave — PHASE 2 : task state unification + device-aware approvals
-- (TRINITY spec §78.2 / §50)
--
-- 1. tasks_status_check: add the Phase 2 lifecycle states while KEEPING the
--    live PAUSED status added by 0049. The state machine in
--    modules/autonomy/state-machine.ts enforces legal transitions in the app;
--    this constraint is the database backstop so a bypass can never persist a
--    semantically impossible value.
--      previous (0049): CREATED,PLANNED,WAITING_APPROVAL,RUNNING,TESTING,
--                       VERIFIED,COMPLETED,FAILED,TIMED_OUT,CANCELLED,BLOCKED,
--                       WAITING_FOR_LOCAL_AGENT,REQUIRES_REVIEW,PAUSED
--      new: + READY, EXECUTING, WAITING_FOR_DEVICE, RECOVERABLE
-- 2. Device-aware approvals: an approval may be scoped to a specific paired
--    device (the agent that must perform the action) and may REQUIRE a paired
--    device at decision time. §50 server-authoritative human gate.
-- 3. Shared remote control (remote-mouse): each remote session may authorize
--    INPUT (mouse/keyboard stream) with an expiry, and an allow-list of
--    controllers — both parties can drive the same cursor concurrently.
--    Mirrors the existing screenshot_authorized gate; nothing executes without
--    an explicit, unexpired authorization on the ACTIVE session.
--
-- Additive only. No existing rows are disturbed; all new columns are nullable
-- or defaulted so deployed data stays valid.
-- ---------------------------------------------------------------------------

-- ----------------------------------------------------------- 1. task states
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (
  status IN ('CREATED','PLANNED','WAITING_APPROVAL','RUNNING','TESTING',
             'VERIFIED','COMPLETED','FAILED','TIMED_OUT','CANCELLED',
             'BLOCKED','WAITING_FOR_LOCAL_AGENT','REQUIRES_REVIEW','PAUSED',
             'READY','EXECUTING','WAITING_FOR_DEVICE','RECOVERABLE')
);

-- Device-aware execution hooks for the new states: which paired device a task
-- is staged on (WAITING_FOR_DEVICE) and which device is actually running it
-- (EXECUTING). Nullable; CLOUD tasks never fill these.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS reserved_device_id text REFERENCES devices(id),
  ADD COLUMN IF NOT EXISTS executing_on_device_id text REFERENCES devices(id),
  ADD COLUMN IF NOT EXISTS ready_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_tasks_device_ready
  ON tasks (executing_on_device_id, status)
  WHERE status IN ('WAITING_FOR_DEVICE','READY','EXECUTING');

-- --------------------------------------------------------- 2. approvals scoped
ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS agent_id text REFERENCES devices(id),
  ADD COLUMN IF NOT EXISTS requires_paired_device boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_approvals_agent_status
  ON approvals (agent_id, status);

-- -------------------------------------------------- 3. remote input (shared mouse)
ALTER TABLE remote_sessions
  ADD COLUMN IF NOT EXISTS input_authorized boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS input_auth_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS allowed_controllers text[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_remote_sessions_input
  ON remote_sessions (device_id)
  WHERE state = 'ACTIVE' AND input_authorized = true;

-- Expiry sweep must also clear the input grant, so an expired session can
-- never keep a stale "mouse open" grant even if the app is notified late.
CREATE OR REPLACE FUNCTION expire_remote_sessions()
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  updated bigint;
BEGIN
  UPDATE remote_sessions
     SET state = 'EXPIRED', screenshot_authorized = false, input_authorized = false
   WHERE state = 'ACTIVE' AND expires_at < now();
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated;
END $$;