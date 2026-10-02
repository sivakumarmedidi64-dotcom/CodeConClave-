-- 0020: phase 1 — auth contract fixes (static validation findings).
--
-- google.ts upserts OAuth connections with ON CONFLICT (user_id); that
-- requires a UNIQUE constraint on user_id. 0019 only created a non-unique
-- index, so the upsert would fail at runtime. This migration closes the gap.

ALTER TABLE google_connections ADD CONSTRAINT uq_google_connections_user UNIQUE (user_id);
