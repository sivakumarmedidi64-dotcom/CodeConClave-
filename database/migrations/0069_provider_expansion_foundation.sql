-- 0069: Provider Expansion Foundation (Qwen, Gemma, Devin, Z Code 5.3 sentinel).
-- Extends the provider_id CHECK constraints, adds capability_category column,
-- seeds model registry entries for verified providers, and creates an UNVERIFIED
-- sentinel for Z Code 5.3.
--
-- This migration is purely additive. No existing rows are modified or deleted.
-- Existing providers (anthropic, openai, google, mistral, grok, deepseek, kimi,
-- nemotron, north) are unaffected.

-- ---------------------------------------------------------------- 1) Extend provider_id CHECK constraints

ALTER TABLE ai_model_registry DROP CONSTRAINT ai_model_registry_provider_id_check;
ALTER TABLE ai_model_registry ADD CONSTRAINT ai_model_registry_provider_id_check
  CHECK (provider_id IN (
    'anthropic','openai','google','mistral','grok','deepseek','kimi','nemotron','north',
    'qwen','gemma','devin','z_code_5_3'
  ));

ALTER TABLE provider_health DROP CONSTRAINT provider_health_provider_id_check;
ALTER TABLE provider_health ADD CONSTRAINT provider_health_provider_id_check
  CHECK (provider_id IN (
    'anthropic','openai','google','mistral','grok','deepseek','kimi','nemotron','north',
    'qwen','gemma','devin','z_code_5_3'
  ));

-- ---------------------------------------------------------------- 2) Add capability_category column to ai_model_registry
-- MODEL = standard chat/completion adapter (default for all existing rows)
-- EXTERNAL_AGENT = out-of-band job lifecycle (e.g. Devin)

ALTER TABLE ai_model_registry
  ADD COLUMN capability_category text NOT NULL DEFAULT 'MODEL';

-- ---------------------------------------------------------------- 3) Qwen models (DashScope OpenAI-compatible)
-- Base URL: https://dashscope-intl.aliyuncs.com/compatible-mode/v1
-- Auth: Bearer token (DASHSCOPE_API_KEY)
-- Verified model IDs (Qwen Cloud docs 2026-09): qwen3-coder-next, qwen3.8-max,
-- qwen3.7-plus, qwen3.6-plus, qwen3.5-flash

INSERT INTO ai_model_registry
  (model_id, provider_id, display_name, tier, compute_class, context_window,
   supports_vision, supports_tools, supports_function_calling,
   input_cost_per_m, output_cost_per_m, entitlement, privacy_class,
   target_latency_ms, health, priority, fallback_list, enabled,
   coding_optimized, capability_category)
VALUES
  ('qwen3-coder-next', 'qwen', 'Qwen Coder Next', 'CAPABLE', 'B', 128000,
   false, true, true, 0.25, 1.00, 'FREE', 'STANDARD',
   3500, 'UNKNOWN', 52, '["deepseek-v4-pro"]', true,
   true, 'MODEL'),
  ('qwen3.8-max', 'qwen', 'Qwen 3.8 Max', 'PREMIUM', 'C', 1000000,
   true, true, true, 2.00, 6.00, 'PRO', 'STANDARD',
   4000, 'UNKNOWN', 22, '["qwen3.7-plus"]', true,
   false, 'MODEL'),
  ('qwen3.7-plus', 'qwen', 'Qwen 3.7 Plus', 'CAPABLE', 'B', 1000000,
   true, true, true, 0.50, 2.00, 'FREE', 'STANDARD',
   3000, 'UNKNOWN', 48, '["qwen3.6-plus","deepseek-v4-pro"]', true,
   false, 'MODEL'),
  ('qwen3.6-plus', 'qwen', 'Qwen 3.6 Plus', 'EFFICIENT', 'A', 1000000,
   true, true, true, 0.40, 1.20, 'FREE', 'STANDARD',
   2500, 'UNKNOWN', 56, '["qwen3.5-flash","gemini-3.7-flash"]', true,
   false, 'MODEL'),
  ('qwen3.5-flash', 'qwen', 'Qwen 3.5 Flash', 'EFFICIENT', 'A', 128000,
   false, true, true, 0.15, 0.60, 'FREE', 'STANDARD',
   1800, 'UNKNOWN', 60, '["gemini-3.7-flash","deepseek-v4-flash"]', true,
   false, 'MODEL')
ON CONFLICT (model_id) DO NOTHING;

-- ---------------------------------------------------------------- 4) Gemma models (Google Gemini API)
-- Same base URL and API key as the google provider (GEMINI_API_KEY).
-- Models served at generativelanguage.googleapis.com.
-- Verified Gemma 3 family (Google AI docs 2026-09): gemma-3-27b-it

INSERT INTO ai_model_registry
  (model_id, provider_id, display_name, tier, compute_class, context_window,
   supports_vision, supports_tools, supports_function_calling,
   input_cost_per_m, output_cost_per_m, entitlement, privacy_class,
   target_latency_ms, health, priority, fallback_list, enabled,
   coding_optimized, capability_category)
VALUES
  ('gemma-3-27b-it', 'gemma', 'Gemma 3 27B', 'EFFICIENT', 'A', 128000,
   true, false, false, 0.10, 0.40, 'FREE', 'STANDARD',
   2000, 'UNKNOWN', 65, '["gemini-3.7-flash"]', true,
   false, 'MODEL')
ON CONFLICT (model_id) DO NOTHING;

-- ---------------------------------------------------------------- 5) Devin — external autonomous engineering agent
-- API: https://api.devin.ai/v1/sessions (create), /v1/sessions/{id} (status)
-- Auth: Bearer token (DEVIN_API_KEY, cog_ prefix)
-- Devin is NOT a chat/completion model; it is an external autonomous agent
-- resource entered through the same CodeConClave orchestration system.
-- capability_category = EXTERNAL_AGENT

INSERT INTO ai_model_registry
  (model_id, provider_id, display_name, tier, compute_class, context_window,
   supports_vision, supports_tools, supports_function_calling,
   input_cost_per_m, output_cost_per_m, entitlement, privacy_class,
   target_latency_ms, health, priority, fallback_list, enabled,
   coding_optimized, capability_category)
VALUES
  ('devin-session', 'devin', 'Devin (External Agent)', 'PREMIUM', 'C', 0,
   true, true, true, 0.00, 0.00, 'PRO', 'STRICT',
   0, 'UNKNOWN', 5, '[]', true,
   true, 'EXTERNAL_AGENT')
ON CONFLICT (model_id) DO NOTHING;

-- ---------------------------------------------------------------- 6) Z Code 5.3 — UNVERIFIED sentinel
-- No legitimate API endpoint, model ID, or provider identity could be
-- established from authoritative documentation. Registered with honest
-- UNVERIFIED state and disabled by default. Provider must be verified
-- before activation.

INSERT INTO ai_model_registry
  (model_id, provider_id, display_name, tier, compute_class, context_window,
   supports_vision, supports_tools, supports_function_calling,
   input_cost_per_m, output_cost_per_m, entitlement, privacy_class,
   target_latency_ms, health, priority, fallback_list, enabled,
   coding_optimized, capability_category)
VALUES
  ('z-code-5-3', 'z_code_5_3', 'Z Code 5.3 (UNVERIFIED)', 'EFFICIENT', 'A', 0,
   false, false, false, 0.00, 0.00, 'FREE', 'STRICT',
   0, 'DOWN', 99, '[]', false,
   false, 'MODEL')
ON CONFLICT (model_id) DO NOTHING;

-- ---------------------------------------------------------------- 7) Seed provider_health for new providers

INSERT INTO provider_health (provider_id, state)
VALUES
  ('qwen',      'UNKNOWN'),
  ('gemma',     'UNKNOWN'),
  ('devin',     'UNKNOWN'),
  ('z_code_5_3','DOWN')
ON CONFLICT (provider_id) DO NOTHING;
