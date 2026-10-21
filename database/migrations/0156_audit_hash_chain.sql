-- 0156: Tamper-evident audit log (hash chain).
--   Every new audit row joins a per-tenant chain ("USER:<id>", "TEAM:<id>",
--   "SYSTEM:system"): chain_seq increments by one and
--     row_hash = sha256(prev_hash | chain_seq | canonical-json(row))
--   so any edited, reordered or deleted row breaks verification. Rows written
--   before this migration have no chain (chain_key NULL) and are reported as
--   "legacy", never as verified.

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS chain_key text;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS chain_seq bigint;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS prev_hash text;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS row_hash text;

-- One row per position in a chain: a forked or replayed write fails loudly.
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_logs_chain
  ON audit_logs (chain_key, chain_seq)
  WHERE chain_key IS NOT NULL;

-- The latest (seq, hash) of every chain, written in the same transaction as
-- each audit row. Lets verification catch a truncated tail (deleting the
-- newest rows leaves no gap inside the chain itself).
CREATE TABLE IF NOT EXISTS audit_chain_heads (
  chain_key  text PRIMARY KEY,
  last_seq   bigint NOT NULL,
  last_hash  text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Service table: read/written only in system scope (no user policies).
ALTER TABLE audit_chain_heads ENABLE ROW LEVEL SECURITY;
