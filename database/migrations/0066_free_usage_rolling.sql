-- 0066: Rolling free-usage window.
-- Additive. Replaces the calendar-day free-message gate with a server-side
-- rolling window so free users are never hard-reset at UTC midnight while a
-- window is active: the allowance runs for FREE_USAGE_WINDOW_HOURS from the
-- first consumed message, after which it replenishes automatically.
--
-- free_usage_windows : one row per owner. Keeps the current window start and
--                      the number of messages consumed inside it. Updates are
--                      atomic: a single statement resets an expired window
--                      (used -> 0, window_start -> now()) and only increments
--                      when used < FREE_DAILY_MESSAGES, so concurrent chat
--                      requests can never overshoot the cap.
--
-- The legacy usage_counters.daily_messages counter is preserved for daily
-- display; enforcement now lives in free_usage_windows.

CREATE TABLE IF NOT EXISTS free_usage_windows (
  owner_id     text PRIMARY KEY,
  window_start timestamptz,
  used         integer NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS free_usage_windows_updated_at_idx
  ON free_usage_windows (updated_at DESC);