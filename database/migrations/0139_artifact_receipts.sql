-- ---------------------------------------------------------------------------
-- 0139_artifact_receipts.sql
-- Verified Execution Receipts (blueprint #1). Every completed engine task
-- emits one machine-readable receipt proving how its artifact was produced:
-- run identities, input/output hashes, verification outcome, artifact sha.
-- Receipts are hash-chained per task (each row commits to the previous
-- receipt hash) so tampering or silent reordering is detectable by
-- recomputation. Append-only: no UPDATE/DELETE path exists. Additive only.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS artifact_receipts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  run_refs JSONB NOT NULL DEFAULT '[]',
  input_hashes JSONB NOT NULL DEFAULT '[]',
  verification TEXT NOT NULL,
  models JSONB NOT NULL DEFAULT '[]',
  prev_receipt_hash TEXT NULL,
  receipt_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_artifact_receipts_task_created
  ON artifact_receipts (task_id, created_at DESC);
