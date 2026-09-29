-- 0132: provider CHECK hygiene (no behavior change, no data change).
-- 0127 admitted a 'cohere' provider_id that no backend adapter, registry key
-- map, or seed row uses (Cohere is served as 'north'; see providers.ts,
-- registry.ts configuredProviders, 0128 seeds). An unconstrained CHECK value
-- that fails closed everywhere else is a schema-hygiene defect: remove it so
-- the database contract matches the 15 real provider ids. No seed row uses
-- 'cohere' (0128/0129 use nemotron/google/mistral/north only), so the
-- constraint replacement cannot reject existing rows.

ALTER TABLE ai_model_registry
  DROP CONSTRAINT ai_model_registry_provider_id_check,
  ADD CONSTRAINT ai_model_registry_provider_id_check
    CHECK (provider_id IN (
      'anthropic','openai','google','mistral',
      'grok','deepseek','kimi','north','nemotron',
      'qwen','gemma','devin','ox_alpha','manus','z_code_5_3'
    ));

ALTER TABLE provider_health
  DROP CONSTRAINT provider_health_provider_id_check,
  ADD CONSTRAINT provider_health_provider_id_check
    CHECK (provider_id IN (
      'anthropic','openai','google','mistral',
      'grok','deepseek','kimi','north','nemotron',
      'qwen','gemma','devin','ox_alpha','manus','z_code_5_3'
    ));
