-- 0054: V4D Production Intelligence — log analysis, error correlation, request tracing, DB performance, monitoring, runbooks, cost analysis

-- Log analysis
CREATE TABLE IF NOT EXISTS log_analyses (
  id                   text PRIMARY KEY,
  project_id           text NOT NULL REFERENCES projects(id),
  started_at           timestamptz NOT NULL,
  completed_at         timestamptz NOT NULL,
  time_window_ms       bigint NOT NULL,
  total_errors         int NOT NULL,
  repeated_errors      jsonb NOT NULL DEFAULT '[]',
  anomalies            jsonb NOT NULL DEFAULT '[]',
  related_failures     jsonb NOT NULL DEFAULT '[]',
  slow_queries         jsonb NOT NULL DEFAULT '[]',
  security_signals     jsonb NOT NULL DEFAULT '[]',
  user_impact_patterns jsonb NOT NULL DEFAULT '[]',
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_log_analyses_project ON log_analyses (project_id);
CREATE INDEX IF NOT EXISTS idx_log_analyses_completed ON log_analyses (completed_at DESC);

-- Error correlation chains
CREATE TABLE IF NOT EXISTS correlation_chains (
  id                   text PRIMARY KEY,
  project_id           text NOT NULL REFERENCES projects(id),
  correlation_id       text NOT NULL,
  request_id           text,
  user_id              text REFERENCES users(id),
  session_id           text,
  chain                jsonb NOT NULL DEFAULT '[]',
  user_impact          jsonb NOT NULL DEFAULT '{}',
  timeline             jsonb NOT NULL DEFAULT '[]',
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_correlation_chains_project ON correlation_chains (project_id);
CREATE INDEX IF NOT EXISTS idx_correlation_chains_correlation ON correlation_chains (correlation_id);
CREATE INDEX IF NOT EXISTS idx_correlation_chains_user ON correlation_chains (user_id);

-- Request tracing
CREATE TABLE IF NOT EXISTS http_requests (
  id                   text PRIMARY KEY,
  project_id           text NOT NULL REFERENCES projects(id),
  method               text NOT NULL,
  path                 text NOT NULL,
  user_id              text REFERENCES users(id),
  started_at           timestamptz NOT NULL,
  completed_at         timestamptz,
  duration_ms          int,
  status               text NOT NULL CHECK (status IN ('SUCCESS','FAILED','TIMEOUT','CANCELLED')),
  status_code          int,
  correlation_id       text,
  error                text,
  metadata             jsonb NOT NULL DEFAULT '{}',
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_http_requests_project ON http_requests (project_id);
CREATE INDEX IF NOT EXISTS idx_http_requests_correlation ON http_requests (correlation_id);
CREATE INDEX IF NOT EXISTS idx_http_requests_user ON http_requests (user_id);
CREATE INDEX IF NOT EXISTS idx_http_requests_started ON http_requests (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_http_requests_status ON http_requests (status);

-- DB Performance reports
CREATE TABLE IF NOT EXISTS db_performance_reports (
  id                   text PRIMARY KEY,
  project_id           text NOT NULL REFERENCES projects(id),
  generated_at         timestamptz NOT NULL,
  time_window_ms       bigint NOT NULL,
  slow_queries         jsonb NOT NULL DEFAULT '[]',
  missing_indexes      jsonb NOT NULL DEFAULT '[]',
  long_transactions    jsonb NOT NULL DEFAULT '[]',
  connection_pressure  jsonb NOT NULL DEFAULT '{}',
  lock_patterns        jsonb NOT NULL DEFAULT '[]',
  table_stats          jsonb NOT NULL DEFAULT '[]',
  recommendations      jsonb NOT NULL DEFAULT '[]',
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_db_perf_reports_project ON db_performance_reports (project_id);
CREATE INDEX IF NOT EXISTS idx_db_perf_reports_generated ON db_performance_reports (generated_at DESC);

-- Monitoring autopilot config
CREATE TABLE IF NOT EXISTS monitoring_autopilot_config (
  project_id           text PRIMARY KEY REFERENCES projects(id),
  config               jsonb NOT NULL DEFAULT '{}',
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_monitoring_config_updated
  BEFORE UPDATE ON monitoring_autopilot_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Alert history
CREATE TABLE IF NOT EXISTS alert_history (
  id                   text PRIMARY KEY,
  severity             text NOT NULL CHECK (severity IN ('CRITICAL','HIGH','MEDIUM','LOW','INFO')),
  message              text NOT NULL,
  source               text NOT NULL,
  timestamp            timestamptz NOT NULL,
  metadata             jsonb NOT NULL DEFAULT '{}',
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_history_timestamp ON alert_history (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_alert_history_source ON alert_history (source);

-- Suppression rules
CREATE TABLE IF NOT EXISTS suppression_rules (
  id                   text PRIMARY KEY,
  rule                 jsonb NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Runbooks
CREATE TABLE IF NOT EXISTS runbooks (
  id                   text PRIMARY KEY,
  project_id           text NOT NULL REFERENCES projects(id),
  name                 text NOT NULL,
  description          text,
  trigger              text NOT NULL CHECK (trigger IN ('ERROR_THRESHOLD','METRIC_THRESHOLD','HEALTH_CHECK_FAILURE','SCHEDULE','MANUAL','ALERT_CORRELATION','SECURITY_SIGNAL')),
  trigger_config       jsonb NOT NULL DEFAULT '{}',
  steps                jsonb NOT NULL DEFAULT '[]',
  status               text NOT NULL DEFAULT 'DETECTED' CHECK (status IN ('DETECTED','PLANNING','PENDING_APPROVAL','APPROVED','EXECUTING','VERIFYING','COMPLETED','FAILED','CANCELLED','ROLLED_BACK')),
  current_step_index   int NOT NULL DEFAULT 0,
  created_by           text NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz,
  completed_at         timestamptz,
  rollback_plan        jsonb,
  metadata             jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_runbooks_project ON runbooks (project_id);
CREATE INDEX IF NOT EXISTS idx_runbooks_status ON runbooks (status);
CREATE INDEX IF NOT EXISTS idx_runbooks_created ON runbooks (created_at DESC);

CREATE TRIGGER trg_runbooks_updated
  BEFORE UPDATE ON runbooks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Runbook templates
CREATE TABLE IF NOT EXISTS runbook_templates (
  id                   text PRIMARY KEY,
  name                 text NOT NULL,
  description          text,
  category             text NOT NULL CHECK (category IN ('INCIDENT_RESPONSE','DEPLOYMENT','SCALING','RECOVERY','MAINTENANCE','SECURITY')),
  template             jsonb NOT NULL,
  is_system            boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Runbook executions
CREATE TABLE IF NOT EXISTS runbook_executions (
  id                   text PRIMARY KEY,
  runbook_id           text NOT NULL REFERENCES runbooks(id) ON DELETE CASCADE,
  trigger              text NOT NULL,
  trigger_data         jsonb NOT NULL DEFAULT '{}',
  status               text NOT NULL DEFAULT 'EXECUTING' CHECK (status IN ('EXECUTING','VERIFYING','COMPLETED','FAILED','CANCELLED','ROLLED_BACK')),
  current_step_id      text,
  started_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz,
  executed_by          text NOT NULL REFERENCES users(id),
  steps                jsonb NOT NULL DEFAULT '[]',
  rollback_executed    boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runbook_executions_runbook ON runbook_executions (runbook_id);
CREATE INDEX IF NOT EXISTS idx_runbook_executions_status ON runbook_executions (status);
CREATE INDEX IF NOT EXISTS idx_runbook_executions_started ON runbook_executions (started_at DESC);

-- Rollback plans
CREATE TABLE IF NOT EXISTS rollback_plans (
  id                   text PRIMARY KEY,
  runbook_id           text NOT NULL REFERENCES runbooks(id) ON DELETE CASCADE,
  steps                jsonb NOT NULL DEFAULT '[]',
  status               text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','EXECUTING','COMPLETED','FAILED')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  executed_at          timestamptz
);

CREATE INDEX IF NOT EXISTS idx_rollback_plans_runbook ON rollback_plans (runbook_id);

-- Cost entries
CREATE TABLE IF NOT EXISTS cost_entries (
  id                   text PRIMARY KEY,
  project_id           text NOT NULL REFERENCES projects(id),
  user_id              text REFERENCES users(id),
  category             text NOT NULL CHECK (category IN ('AI_INFERENCE','AI_EMBEDDING','TASK_EXECUTION','AGENT_RUN','STORAGE','COMPUTE','NETWORK','PROVIDER_API','INFRASTRUCTURE','UNKNOWN')),
  source               text NOT NULL CHECK (source IN ('MEASURED','ESTIMATED')),
  amount_usd           numeric(12,4) NOT NULL CHECK (amount_usd >= 0),
  currency             text NOT NULL DEFAULT 'USD',
  quantity             numeric(12,4) NOT NULL DEFAULT 0,
  unit                 text NOT NULL,
  description          text NOT NULL,
  metadata             jsonb NOT NULL DEFAULT '{}',
  recorded_at          timestamptz NOT NULL,
  billing_period_start timestamptz NOT NULL,
  billing_period_end   timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cost_entries_project ON cost_entries (project_id);
CREATE INDEX IF NOT EXISTS idx_cost_entries_user ON cost_entries (user_id);
CREATE INDEX IF NOT EXISTS idx_cost_entries_category ON cost_entries (category);
CREATE INDEX IF NOT EXISTS idx_cost_entries_recorded ON cost_entries (recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_cost_entries_billing ON cost_entries (billing_period_start, billing_period_end);

-- Budgets
CREATE TABLE IF NOT EXISTS budgets (
  id                   text PRIMARY KEY,
  project_id           text NOT NULL REFERENCES projects(id),
  name                 text NOT NULL,
  period               text NOT NULL CHECK (period IN ('DAILY','WEEKLY','MONTHLY','QUARTERLY','YEARLY')),
  limit_usd            numeric(12,2) NOT NULL CHECK (limit_usd >= 0),
  alert_threshold_percent numeric(5,2) NOT NULL DEFAULT 80.00 CHECK (alert_threshold_percent > 0 AND alert_threshold_percent <= 100),
  categories           jsonb NOT NULL DEFAULT '[]',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_budgets_project ON budgets (project_id);

CREATE TRIGGER trg_budgets_updated
  BEFORE UPDATE ON budgets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Cost alerts
CREATE TABLE IF NOT EXISTS cost_alerts (
  id                   text PRIMARY KEY,
  project_id           text NOT NULL REFERENCES projects(id),
  type                 text NOT NULL CHECK (type IN ('BUDGET_EXCEEDED','UNUSUAL_SPIKE','PROVIDER_LIMIT','BUDGET_WARNING')),
  severity             text NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  message              text NOT NULL,
  current_value        numeric(12,4) NOT NULL,
  threshold            numeric(12,2) NOT NULL,
  period               text NOT NULL,
  detected_at          timestamptz NOT NULL DEFAULT now(),
  acknowledged         boolean NOT NULL DEFAULT false,
  acknowledged_at      timestamptz,
  acknowledged_by      text REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cost_alerts_project ON cost_alerts (project_id);
CREATE INDEX IF NOT EXISTS idx_cost_alerts_acknowledged ON cost_alerts (acknowledged);
CREATE INDEX IF NOT EXISTS idx_cost_alerts_severity ON cost_alerts (severity);
CREATE INDEX IF NOT EXISTS idx_cost_alerts_detected ON cost_alerts (detected_at DESC);

-- Query performance log
CREATE TABLE IF NOT EXISTS query_performance_log (
  query_hash           text PRIMARY KEY,
  query_text           text NOT NULL,
  avg_duration_ms      numeric(10,2) NOT NULL,
  max_duration_ms      numeric(10,2) NOT NULL,
  execution_count      int NOT NULL,
  rows_examined        bigint,
  rows_returned        bigint,
  tables_scanned       text[],
  last_seen            timestamptz NOT NULL
);

-- DB performance log (legacy, keep for compatibility)
CREATE TABLE IF NOT EXISTS db_performance_log (
  query_hash           text PRIMARY KEY,
  query_text           text NOT NULL,
  avg_duration_ms      numeric(10,2) NOT NULL,
  max_duration_ms      numeric(10,2) NOT NULL,
  execution_count      int NOT NULL,
  rows_examined        bigint,
  rows_returned        bigint,
  tables_scanned       text[],
  last_seen            timestamptz NOT NULL
);
