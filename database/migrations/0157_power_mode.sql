-- 0157: Power Mode — a time-boxed permission mode.
--   expires_at set  -> `mode` applies only until then, after which the user is
--   back on `revert_to` (or 'ask' if unknown). The server enforces the expiry
--   on every read, so a lapsed grant can never keep working.

ALTER TABLE user_permission_modes ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE user_permission_modes ADD COLUMN IF NOT EXISTS revert_to text
  CHECK (revert_to IS NULL OR revert_to IN ('ask','accept_edits','full_access'));
