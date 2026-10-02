-- Stage 26 — AI gateway transparency: honest provider status taxonomy.
-- Widen provider_health.state to the full derived status set. The gateway now
-- persists classified failure states (RATE_LIMITED / QUOTA_EXHAUSTED /
-- REQUIRES_REAUTH / OFFLINE / DEGRADED) instead of a single DOWN; BLOCKED is
-- reserved for explicit administrative blocks.

ALTER TABLE provider_health DROP CONSTRAINT provider_health_state_check;
ALTER TABLE provider_health ADD CONSTRAINT provider_health_state_check
  CHECK (state IN ('UNKNOWN','HEALTHY','DEGRADED','DOWN','RATE_LIMITED','QUOTA_EXHAUSTED','REQUIRES_REAUTH','OFFLINE','BLOCKED'));