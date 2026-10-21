-- 0160: Per-user permission rules (allow / ask / deny), borrowed from Claude
-- Code, Zed, Continue and Devin, adjusted to CodeConClave's constitution:
--   deny  blocks a matching action, always
--   ask   forces an approval prompt, even in Auto-accept / Auto mode
--   allow skips the prompt for a matching LOW/MEDIUM action only
-- Rules sit BELOW the immutable baseline: they can never unblock a secret
-- path, a dangerous command, a missing capability grant, a delete, or a
-- HIGH/CRITICAL action. Precedence: deny > ask > allow.

CREATE TABLE IF NOT EXISTS user_permission_rules (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  effect      text NOT NULL CHECK (effect IN ('allow','ask','deny')),
  tool        text NOT NULL CHECK (length(tool) BETWEEN 1 AND 40),
  pattern     text NOT NULL CHECK (length(pattern) BETWEEN 1 AND 300),
  note        text CHECK (note IS NULL OR length(note) <= 200),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_permission_rules_user ON user_permission_rules (user_id, created_at);

ALTER TABLE user_permission_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_permission_rules_self ON user_permission_rules;
CREATE POLICY user_permission_rules_self ON user_permission_rules USING (user_id = app.uid());
