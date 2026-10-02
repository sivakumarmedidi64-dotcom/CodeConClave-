-- Stage 26 — multi-agent trust levels (L0-L4).
-- Stored intent on ai_agents.trust_level; the EFFECTIVE level is derived
-- server-side by clamping against the plan's maximum at every enforcement
-- point (create, trust change, run start). Default L2 (Standard).

ALTER TABLE ai_agents ADD COLUMN trust_level text NOT NULL DEFAULT 'L2'
  CHECK (trust_level IN ('L0','L1','L2','L3','L4'));