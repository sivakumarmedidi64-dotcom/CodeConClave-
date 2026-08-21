-- 0041: sessions.updated_at — trg_sessions_updated_at (0002) calls
-- set_updated_at() which sets NEW.updated_at, but the column never existed,
-- so EVERY UPDATE on sessions (logout, revoke, device revoke) failed with
-- `record "new" has no field "updated_at"`. Backfill from created_at.

ALTER TABLE sessions ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
UPDATE sessions SET updated_at = created_at WHERE updated_at <> created_at;