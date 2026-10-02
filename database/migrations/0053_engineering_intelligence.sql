-- 0053: engineering intelligence — refactoring plans, technical debt log, performance metrics

CREATE TABLE IF NOT EXISTS refactoring_plans (
  id                   text PRIMARY KEY,
  project_id           text NOT NULL REFERENCES projects(id),
  user_id              text NOT NULL REFERENCES users(id),
  type                 text NOT NULL CHECK (type IN (
                       'extract_function','rename','move_code','remove_duplication',
                       'simplify_complexity','modernization','type_improvement','safe_async_conversion')),
  target               jsonb NOT NULL,
  steps                jsonb NOT NULL DEFAULT '[]'::jsonb,
  estimated_risk       text NOT NULL CHECK (estimated_risk IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  requires_approval    boolean NOT NULL DEFAULT false,
  approval_id          text REFERENCES approvals(id),
  task_id              text REFERENCES tasks(id),
  status               text NOT NULL DEFAULT 'planned' CHECK (status IN (
                       'planned','approved','in_progress','testing','completed','failed','rolled_back','cancelled')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_refactoring_plans_project ON refactoring_plans (project_id);
CREATE INDEX idx_refactoring_plans_user ON refactoring_plans (user_id);
CREATE INDEX idx_refactoring_plans_status ON refactoring_plans (status);

CREATE TRIGGER trg_refactoring_plans_updated_at
  BEFORE UPDATE ON refactoring_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS technical_debt_log (
  id                   text PRIMARY KEY,
  project_id           text NOT NULL REFERENCES projects(id),
  user_id              text NOT NULL REFERENCES users(id),
  type                 text NOT NULL CHECK (type IN (
                       'code_smell','duplicate_code','excessive_complexity','large_function',
                       'deep_nesting','stale_code','architectural_debt','test_debt')),
  severity             text NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  affected_files       text[] NOT NULL DEFAULT '{}',
  evidence             text NOT NULL,
  estimated_impact     jsonb NOT NULL DEFAULT '{}'::jsonb,
  recommendation       text NOT NULL,
  resolved             boolean NOT NULL DEFAULT false,
  resolved_at          timestamptz,
  resolved_by          text REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_technical_debt_project ON technical_debt_log (project_id);
CREATE INDEX idx_technical_debt_user ON technical_debt_log (user_id);
CREATE INDEX idx_technical_debt_severity ON technical_debt_log (severity);
CREATE INDEX idx_technical_debt_type ON technical_debt_log (type);
CREATE INDEX idx_technical_debt_created ON technical_debt_log (created_at);

CREATE TABLE IF NOT EXISTS performance_metrics (
  id                   text PRIMARY KEY,
  project_id           text NOT NULL REFERENCES projects(id),
  metric_name          text NOT NULL,
  value                numeric(12,4) NOT NULL,
  unit                 text NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  metadata             jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX idx_perf_metrics_project ON performance_metrics (project_id);
CREATE INDEX idx_perf_metrics_name ON performance_metrics (metric_name);
CREATE INDEX idx_perf_metrics_recorded ON performance_metrics (recorded_at);

-- Add updated_at trigger for refactoring_plans if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE trigger_name = 'trg_refactoring_plans_updated_at'
  ) THEN
    CREATE TRIGGER trg_refactoring_plans_updated_at
      BEFORE UPDATE ON refactoring_plans
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;