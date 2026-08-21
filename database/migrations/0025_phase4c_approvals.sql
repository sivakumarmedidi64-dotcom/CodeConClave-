-- ============================================================================
-- 0025 — Phase 4C: Approval Center + human-gate execution
--
-- Extends `approvals` with the full persisted approval record:
--   requesting user metadata (coworker, model), justification, affected
--   resources, the proposed action payload, expiry (server-enforced at
--   execution), decision metadata (already present), execution result
--   reference, audit reference, and batch grouping.
--
-- Lifecycle (server-authoritative):
--   PENDING -> APPROVED -> EXECUTED      (approved, then executed by a human gate)
--   PENDING -> REJECTED -> CANCELLED     (rejected by the owner)
--   PENDING -> EXPIRED                   (never decided before expires_at)
--
-- Adds `approval_resources` so a single (batched) approval can cover many
-- affected resources, and the executed action must stay within them.
-- ============================================================================

ALTER TABLE approvals
  ADD COLUMN action_type            text,
  ADD COLUMN coworker               text,
  ADD COLUMN model                  text,
  ADD COLUMN justification          text,
  ADD COLUMN affected_resources     jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN proposed_action        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN execution_status       text CHECK (execution_status IN ('RUNNING','SUCCEEDED','FAILED')),
  ADD COLUMN execution_started_at   timestamptz,
  ADD COLUMN execution_completed_at timestamptz,
  ADD COLUMN execution_result       jsonb,
  ADD COLUMN audit_reference        text,
  ADD COLUMN batch_group            text;

-- Extend the status machine with EXECUTED and CANCELLED.
ALTER TABLE approvals DROP CONSTRAINT approvals_status_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_status_check
  CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED','REVOKED','EXECUTED','CANCELLED'));

-- Single approval covering many affected resources (batching).
CREATE TABLE approval_resources (
  id           text PRIMARY KEY,
  approval_id  text NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  resource_type text NOT NULL,
  resource_ref text NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_approval_resources_approval ON approval_resources (approval_id);
CREATE INDEX idx_approvals_batch_group ON approvals (batch_group);
CREATE INDEX idx_approvals_action_status ON approvals (action_type, status);

-- RLS: only the owner may read resources of their own approvals.
ALTER TABLE approval_resources ENABLE ROW LEVEL SECURITY;
CREATE POLICY approval_resources_owner ON approval_resources
  USING (EXISTS (
    SELECT 1 FROM approvals a WHERE a.id = approval_resources.approval_id
    AND a.owner_id = app.uid()
  )) WITH CHECK (true);