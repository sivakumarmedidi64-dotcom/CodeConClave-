-- 0145: Meta Muse Spark provider (optional, OFF by default).
-- Extends the provider CHECK constraints with 'muse_spark' and seeds the
-- default model row muse-spark-1.3 (official Meta Model API docs:
-- https://dev.meta.ai/docs/protocols/chat-completions — base
-- https://api.meta.ai/v1, POST /chat/completions, Bearer auth).
--
-- The row is inert by default: routing additionally requires
-- MUSE_SPARK_ENABLED=true AND muse_spark in AI_PROVIDERS_ENABLED AND a
-- server-side MUSE_SPARK_API_KEY. Until then the adapter reports
-- provider_not_configured (CONFIGURATION REQUIRED, never CONNECTED).
-- Idempotent: DELETE + INSERT by model_id; constraint replacement is safe
-- because no existing row uses the new value.

ALTER TABLE ai_model_registry
  DROP CONSTRAINT ai_model_registry_provider_id_check,
  ADD CONSTRAINT ai_model_registry_provider_id_check
    CHECK (provider_id IN (
      'anthropic','openai','google','mistral',
      'grok','deepseek','kimi','north','nemotron',
      'qwen','gemma','devin','ox_alpha','manus','z_code_5_3',
      'muse_spark'
    ));

ALTER TABLE provider_health
  DROP CONSTRAINT provider_health_provider_id_check,
  ADD CONSTRAINT provider_health_provider_id_check
    CHECK (provider_id IN (
      'anthropic','openai','google','mistral',
      'grok','deepseek','kimi','north','nemotron',
      'qwen','gemma','devin','ox_alpha','manus','z_code_5_3',
      'muse_spark'
    ));

DELETE FROM ai_model_registry WHERE model_id IN ('muse-spark-1.3');

-- Muse Spark 1.3 — reasoning/coding text model. Capability flags mirror the
-- documented Chat Completions surface (text, SSE streaming, tool calling,
-- response_format structured output); vision is false for this row because
-- image input on this model id was not verified. Coding-optimized: true
-- (reasoning model intended for coding/agent work via the gateway's coding
-- preference). Entitlement PRO, compute B — premium gating stays in force.
INSERT INTO ai_model_registry (
  model_id, provider_id, display_name, tier, compute_class,
  context_window, supports_vision, supports_tools, supports_function_calling,
  input_cost_per_m, output_cost_per_m, entitlement, privacy_class,
  target_latency_ms, health, priority, fallback_list, enabled,
  effective_date, deprecation_date, coding_optimized, capability_category,
  image_generation, image_editing
) VALUES
('muse-spark-1.3', 'muse_spark', 'Muse Spark 1.3', 'CAPABLE', 'B',
 1048576, false, true, true, 0, 0, 'PRO', 'STANDARD', 4000, 'UNKNOWN', 60, '["gemini-3.7-flash","mistral-small-4"]', true,
 CURRENT_DATE, null, true, 'MODEL', false, false);
