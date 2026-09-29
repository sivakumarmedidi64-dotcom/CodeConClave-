-- 0127: Provider expansion — add new free-tier providers to CHECK constraints
-- Adds: groq, deepseek, kimi, north (Cohere), openai, anthropic, cohere, qwen, gemma, devin, ox_alpha, manus, z_code_5_3

-- ai_model_registry: expand provider_id CHECK constraint
ALTER TABLE ai_model_registry
  DROP CONSTRAINT ai_model_registry_provider_id_check,
  ADD CONSTRAINT ai_model_registry_provider_id_check
    CHECK (provider_id IN (
      'anthropic','openai','google','mistral',
      'grok','deepseek','kimi','north','nemotron',
      'cohere','qwen','gemma','devin','ox_alpha','manus','z_code_5_3'
    ));

-- provider_health: expand provider_id CHECK constraint
ALTER TABLE provider_health
  DROP CONSTRAINT provider_health_provider_id_check,
  ADD CONSTRAINT provider_health_provider_id_check
    CHECK (provider_id IN (
      'anthropic','openai','google','mistral',
      'grok','deepseek','kimi','north','nemotron',
      'cohere','qwen','gemma','devin','ox_alpha','manus','z_code_5_3'
    ));