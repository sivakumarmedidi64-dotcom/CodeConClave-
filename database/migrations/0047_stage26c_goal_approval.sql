-- Stage 26C — goal approval gate reuses the existing approvals table.
-- Additive: the goal row records which approval is gating its execution.
ALTER TABLE goals ADD COLUMN approval_id text REFERENCES approvals(id) ON DELETE SET NULL;