-- 0013: workspace — workspace_state, user_preferences, feature_flags, usage_counters

CREATE TABLE workspace_state (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id),
  key         text NOT NULL,
  value       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_workspace_state UNIQUE (owner_id, key)
);

CREATE TRIGGER trg_workspace_state_updated_at
  BEFORE UPDATE ON workspace_state
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_preferences (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL UNIQUE REFERENCES users(id),
  prefs       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_user_preferences_updated_at
  BEFORE UPDATE ON user_preferences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE feature_flags (
  id          text PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_counters (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id),
  name        text NOT NULL,
  bucket      text NOT NULL,
  value       bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_usage_counters UNIQUE (owner_id, name, bucket)
);

CREATE INDEX idx_usage_counters_owner ON usage_counters (owner_id, name);