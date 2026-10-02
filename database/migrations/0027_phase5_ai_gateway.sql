-- ---------------------------------------------------------------------------
-- CodeConClave — PHASE 5: AI gateway hardening.
-- model_usage_logs: tenant correlation + fallback reasons + coworker scope.
-- compute_policy: config-driven compute governance (A/B/C classes, budget).
--
-- NOTE: static-only migration. PostgreSQL runtime is NOT available in this
-- environment; this file is validated for SQL syntax only. Applied once.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- model_usage_logs — Phase 5 governance columns.
-- ---------------------------------------------------------------------------
ALTER TABLE model_usage_logs
  ADD COLUMN tenant_id text;

ALTER TABLE model_usage_logs
  ADD COLUMN fallback_reason text;

ALTER TABLE model_usage_logs
  ADD COLUMN coworker_type text;

ALTER TABLE model_usage_logs
  ADD COLUMN error_code text;

CREATE INDEX idx_model_usage_tenant_created ON model_usage_logs (tenant_id, created_at);
CREATE INDEX idx_model_usage_task ON model_usage_logs (task_id);

-- ---------------------------------------------------------------------------
-- compute_policy — config-driven compute governance.
-- Operators adjust these rows (or seed them) at runtime; the server reads the
-- table and falls back to environment defaults when empty.
-- ---------------------------------------------------------------------------
CREATE TABLE compute_policy (
  class                     text PRIMARY KEY CHECK (class IN ('A','B','C')),
  description               text NOT NULL,
  max_tier                  text NOT NULL CHECK (max_tier IN ('EFFICIENT','CAPABLE','PREMIUM')),
  premium_budget_usd_per_day numeric(16,6) NOT NULL DEFAULT 0,
  enabled                   boolean NOT NULL DEFAULT true,
  updated_at                timestamptz NOT NULL DEFAULT now()
);

INSERT INTO compute_policy (class, description, max_tier, premium_budget_usd_per_day)
VALUES
  ('A', 'CHEAP — simple questions, explanations, summarization, small edits', 'EFFICIENT', 0),
  ('B', 'STANDARD — normal coding and knowledge work', 'CAPABLE', 0),
  ('C', 'PREMIUM — complex justified work, budget-gated per plan', 'PREMIUM', 4.000000)
ON CONFLICT (class) DO NOTHING;

-- ---------------------------------------------------------------------------
-- RLS: model_usage_logs is backend-written; users may read their own rows
-- (the /api/v1/ai/usage endpoint is already user-scoped).
-- ---------------------------------------------------------------------------
ALTER TABLE model_usage_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY model_usage_logs_owner ON model_usage_logs
  USING (user_id = app.uid()) WITH CHECK (false);