-- ---------------------------------------------------------------------------
-- CodeConClave — 0136 ai_agent_runs.updated_at.
--
-- WHY: ai_agent_runs was created in 0042 with only created_at, but the agents
-- runtime (src/modules/agents/service.ts) both refreshes agent-run state and
-- touch-es runs via `updated_at` (e.g. watchdog keepalives). On production this
-- fails as `column "updated_at" of relation "ai_agent_runs" does not exist`.
-- This is purely additive: it backfills a sensible value (the migration apply
-- time for pre-existing rows), adds the managed column, and mirrors the
-- ai_agents auto-bump trigger, so touch/keepalive paths keep working.
--
-- Safe on every database in the chain (fresh, verify, production).
-- ---------------------------------------------------------------------------

ALTER TABLE ai_agent_runs
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TRIGGER trg_ai_agent_runs_updated_at
  BEFORE UPDATE ON ai_agent_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();