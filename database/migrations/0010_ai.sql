-- 0010: AI — ai_model_registry, model_usage_logs, provider_health

CREATE TABLE ai_model_registry (
  model_id                 text PRIMARY KEY,
  provider_id              text NOT NULL CHECK (provider_id IN ('anthropic','openai','google','mistral')),
  display_name             text NOT NULL,
  tier                     text NOT NULL CHECK (tier IN ('PREMIUM','CAPABLE','EFFICIENT')),
  compute_class            text NOT NULL CHECK (compute_class IN ('A','B','C')),
  context_window           int NOT NULL,
  supports_vision          boolean NOT NULL DEFAULT false,
  supports_tools           boolean NOT NULL DEFAULT false,
  supports_function_calling boolean NOT NULL DEFAULT false,
  input_cost_per_m         numeric(16,6) NOT NULL DEFAULT 0,
  output_cost_per_m        numeric(16,6) NOT NULL DEFAULT 0,
  entitlement              text NOT NULL DEFAULT 'FREE' CHECK (entitlement IN ('FREE','PRO')),
  privacy_class            text NOT NULL DEFAULT 'STANDARD' CHECK (privacy_class IN ('PUBLIC','STANDARD','STRICT')),
  target_latency_ms        int NOT NULL DEFAULT 5000,
  health                   text NOT NULL DEFAULT 'UNKNOWN' CHECK (health IN ('UNKNOWN','HEALTHY','DEGRADED','DOWN')),
  priority                 int NOT NULL DEFAULT 100,
  fallback_list            jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled                  boolean NOT NULL DEFAULT true,
  effective_date           date NOT NULL DEFAULT CURRENT_DATE,
  deprecation_date         date
);

CREATE TABLE model_usage_logs (
  id                   text PRIMARY KEY,
  user_id              text NOT NULL REFERENCES users(id),
  task_id              text REFERENCES tasks(id),
  session_id           text NOT NULL,
  conversation_id      text REFERENCES conversations(id),
  provider_id          text NOT NULL,
  model_id             text NOT NULL,
  plan_id              text NOT NULL,
  compute_class        text NOT NULL,
  input_tokens         int NOT NULL,
  output_tokens        int NOT NULL,
  estimated_cost_usd   numeric(16,6) NOT NULL,
  actual_cost_usd      numeric(16,6),
  duration_ms          int,
  used_fallback        boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_model_usage_user_created ON model_usage_logs (user_id, created_at);
CREATE INDEX idx_model_usage_provider_created ON model_usage_logs (provider_id, created_at);

CREATE TABLE provider_health (
  provider_id          text PRIMARY KEY CHECK (provider_id IN ('anthropic','openai','google','mistral')),
  state                text NOT NULL DEFAULT 'UNKNOWN' CHECK (state IN ('UNKNOWN','HEALTHY','DEGRADED','DOWN')),
  last_check_at        timestamptz,
  last_error           text,
  consecutive_failures int NOT NULL DEFAULT 0,
  success_count        bigint NOT NULL DEFAULT 0,
  failure_count        bigint NOT NULL DEFAULT 0,
  avg_latency_ms       numeric(10,2),
  updated_at           timestamptz NOT NULL DEFAULT now()
);