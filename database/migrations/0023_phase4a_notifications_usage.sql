-- 0023: phase 4a — notifications, notification_preferences, usage_events
-- Tenant isolation: notifications/usage are user-scoped (recipient/owner);
-- RLS enforces recipient isolation; retention helper expires stale rows.

CREATE TABLE notifications (
  id             text PRIMARY KEY,
  recipient_id   text NOT NULL REFERENCES users(id),
  type           text NOT NULL,
  title          text NOT NULL,
  body           text,
  read           boolean NOT NULL DEFAULT false,
  read_at        timestamptz,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  resource_type  text,
  resource_id    text,
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);

CREATE INDEX idx_notifications_recipient_created ON notifications (recipient_id, created_at DESC);
CREATE INDEX idx_notifications_recipient_unread
  ON notifications (recipient_id, read)
  WHERE deleted_at IS NULL;

CREATE TABLE notification_preferences (
  id         text PRIMARY KEY,
  owner_id   text NOT NULL UNIQUE REFERENCES users(id),
  prefs      jsonb NOT NULL DEFAULT '{}'::jsonb,
  version    bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_notification_preferences_updated_at
  BEFORE UPDATE ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE usage_events (
  id         text PRIMARY KEY,
  owner_id   text NOT NULL REFERENCES users(id),
  name       text NOT NULL,
  bucket     text NOT NULL,
  measured   boolean NOT NULL DEFAULT true,
  quantity   numeric(20,4) NOT NULL,
  unit       text NOT NULL DEFAULT 'count',
  meta       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_usage_events_owner_bucket ON usage_events (owner_id, name, bucket, created_at);

-- Retention: purge soft-deleted notifications after retention_days and
-- auto-read expired ones. Invoke via scheduled job or manual maintenance.
CREATE FUNCTION expire_notifications(retention_days int DEFAULT 90)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  removed bigint;
BEGIN
  DELETE FROM notifications
   WHERE deleted_at IS NOT NULL AND deleted_at < now() - make_interval(days => retention_days);
  UPDATE notifications
     SET read = true
   WHERE read = false AND expires_at IS NOT NULL AND expires_at < now();
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_recipient_isolation ON notifications
  USING (recipient_id = app.uid()) WITH CHECK (recipient_id = app.uid());

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_preferences_owner_isolation ON notification_preferences
  USING (owner_id = app.uid()) WITH CHECK (owner_id = app.uid());

ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY usage_events_owner_isolation ON usage_events
  USING (owner_id = app.uid()) WITH CHECK (owner_id = app.uid());