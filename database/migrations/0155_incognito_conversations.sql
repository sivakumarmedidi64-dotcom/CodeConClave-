-- 0155: Incognito chats.
--   An incognito conversation is never listed in Recents/search, never reads or
--   writes memory/DNA/decisions, and is permanently deleted (messages and all)
--   by the watchdog once it has been idle for INCOGNITO_RETENTION_HOURS.
-- Row-level security is unchanged: incognito rows stay owner-only like any
-- other conversation.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS incognito boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_conversations_incognito_idle
  ON conversations (updated_at)
  WHERE incognito;
