-- ---------------------------------------------------------------------------
-- 0144_browser_instruction.sql
-- P1 paired-device browser automation: a LOCAL task may carry an explicit,
-- server-validated browser instruction (JSON) describing the actions a managed
-- browser session may take. Additive: existing columns and statuses are
-- untouched. The instruction is the ONLY thing the agent is told to execute;
-- there is never free-form browser code or a prompt in the payload.
-- ---------------------------------------------------------------------------

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS local_instruction jsonb;