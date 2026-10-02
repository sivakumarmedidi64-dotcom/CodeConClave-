-- ---------------------------------------------------------------------------
-- 0140_spec_proofs.sql
-- Spec-to-Proof Loop (blueprint #6). Plan acceptance criteria become rows;
-- each row carries a machine-checked verdict (PASS/FAIL/SKIPPED) plus the
-- evidence that produced it (verification string, artifact sha, run refs).
-- A criterion is PASS only when a real verifier ran; otherwise it is
-- SKIPPED with the reason recorded — the matrix can never claim proof it
-- does not have. One proof row per (receipt, criterion). Additive only.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS spec_proofs (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES artifact_receipts (id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  criterion TEXT NOT NULL,
  verdict TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT spec_proofs_verdict CHECK (verdict IN ('PASS', 'FAIL', 'SKIPPED'))
);

CREATE INDEX IF NOT EXISTS idx_spec_proofs_receipt
  ON spec_proofs (receipt_id);
CREATE INDEX IF NOT EXISTS idx_spec_proofs_task_created
  ON spec_proofs (task_id, created_at DESC);
