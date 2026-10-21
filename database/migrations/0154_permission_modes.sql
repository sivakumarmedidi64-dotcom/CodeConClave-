-- 0154: Per-user permission mode for agent actions (Claude-style).
--   ask          every write / non-LOW command asks for approval (default)
--   accept_edits file create/write inside a granted workspace runs without asking
--   full_access  accept_edits + MEDIUM-risk commands run without asking
-- Never relaxed by any mode: immutable baseline denials (secrets, dangerous
-- commands, traversal), capability grants, deletes and HIGH/CRITICAL commands.

CREATE TABLE IF NOT EXISTS user_permission_modes (
  user_id     text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode        text NOT NULL DEFAULT 'ask' CHECK (mode IN ('ask','accept_edits','full_access')),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_permission_modes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_permission_modes_self ON user_permission_modes;
CREATE POLICY user_permission_modes_self ON user_permission_modes USING (user_id = app.uid());
