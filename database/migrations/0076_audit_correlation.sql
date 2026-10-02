-- ---------------------------------------------------------------------------
-- 0076_audit_correlation.sql
-- audit_logs.correlation_id has been referenced by the audit service (INSERT
-- and SELECT) since the audit module was introduced, but the column was never
-- added to the schema. The INSERT failure was swallowed by recordAudit's
-- catch, so every audit write in production was silently lost. Additive only.
-- ---------------------------------------------------------------------------

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS correlation_id text;

CREATE INDEX IF NOT EXISTS idx_audit_logs_correlation
  ON audit_logs (correlation_id);