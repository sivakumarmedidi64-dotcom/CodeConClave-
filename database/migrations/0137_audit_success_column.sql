-- ---------------------------------------------------------------------------
-- 0137_audit_success_column.sql
-- logAnalysis.auditErrors filters `success = false`, but audit_logs never had
-- such a column (only 0014 created it; 0076 added correlation_id). Every run
-- of that query would fail with `column audit_logs.success does not exist`.
-- Additive only; backfilled to true so historical rows still qualify as
-- successful. DEFAULT true keeps every existing recordAudit caller valid.
-- ---------------------------------------------------------------------------

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS success boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_audit_logs_success_created
  ON audit_logs (success, created_at DESC);