-- 0163: Agent Sai Srinivasa Athreya — the shared CASE FILE.
--
-- When Agent Sai runs as a team of regional detectives (India, US, Singapore,
-- Australia…), each one pulls its local public sources. This table is the one
-- place they ALL write what they catch and ALL read from — so a pull by one
-- region is instantly available to every other region and every process.
--
-- This is PUBLIC, non-tenant data (the results of free public APIs), so it runs
-- WITHOUT row-level security, exactly like the global state tables in 0142
-- (auth_rate_counters et al). It is accessed system-scoped via the shared pool,
-- never per-user. Nothing here is secret and nothing is faked — each row keeps
-- the real fetch time and the region that caught it.
CREATE TABLE IF NOT EXISTS sai_cache (
  cache_key   text PRIMARY KEY,                 -- `${source_id}\n${query}`
  source_id   text NOT NULL,
  query       text NOT NULL DEFAULT '',
  evidence    jsonb NOT NULL,                   -- the SaiEvidence payload (summary, data, sourceUrl, fetchedAt…)
  region      text NOT NULL DEFAULT 'global',   -- which detective caught it (SAI_REGION)
  stored_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL              -- freshness window; past this it is re-pulled
);

-- Fast expiry sweep (watchdog) and newest-first per-source lookups.
CREATE INDEX IF NOT EXISTS idx_sai_cache_expires ON sai_cache (expires_at);
CREATE INDEX IF NOT EXISTS idx_sai_cache_source ON sai_cache (source_id, stored_at DESC);
