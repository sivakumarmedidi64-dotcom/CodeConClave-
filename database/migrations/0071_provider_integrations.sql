-- 0071: Provider Integration (Prompt 3). Extends provider_id CHECK constraints
-- for the verified Ox Alpha (OpenRouter) and Manus external-agent providers,
-- adds an explicit image-generation/image-editing capability marker so the
-- model registry honestly distinguishes text vs multimodal vs image-generation
-- models, corrects the Z Code 5.3 identity mismatch (z-code-5-3 -> glm-5.3),
-- and seeds the new provider rows (disabled until real verification flips them).
--
-- Purely additive except the single identity correction UPDATE. Existing
-- providers and payment architecture are untouched.

-- ---------------------------------------------------------------- 1) Extend provider_id CHECK constraints

ALTER TABLE ai_model_registry DROP CONSTRAINT ai_model_registry_provider_id_check;
ALTER TABLE ai_model_registry ADD CONSTRAINT ai_model_registry_provider_id_check
  CHECK (provider_id IN (
    'anthropic','openai','google','mistral','grok','deepseek','kimi','nemotron','north',
    'qwen','gemma','devin','ox_alpha','manus','z_code_5_3'
  ));

ALTER TABLE provider_health DROP CONSTRAINT provider_health_provider_id_check;
ALTER TABLE provider_health ADD CONSTRAINT provider_health_provider_id_check
  CHECK (provider_id IN (
    'anthropic','openai','google','mistral','grok','deepseek','kimi','nemotron','north',
    'qwen','gemma','devin','ox_alpha','manus','z_code_5_3'
  ));

-- ---------------------------------------------------------------- 2) Explicit image capability markers
-- IMAGE_GENERATION / IMAGE_EDITING are canonical where the configured model
-- actually supports them. Nothing is derived from provider heuristics; a model
-- is image-capable ONLY when its row says so. (ModelCapabilities.imageGeneration/
-- imageEditing read these columns; see modules/ai/capabilities.ts.)

ALTER TABLE ai_model_registry
  ADD COLUMN image_generation boolean NOT NULL DEFAULT false;

ALTER TABLE ai_model_registry
  ADD COLUMN image_editing boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------- 3) Correct Z Code 5.3 identity mismatch
-- The previous gate registered an UNVERIFIED sentinel under model_id
-- 'z-code-5-3'. Verification established the real vendor identity: Z.ai
-- GLM-5.3 (ZCode) at https://api.z.ai/api/v1, model id 'glm-5.3'. Repoint the
-- row to the verified identity. It stays DISABLED until a real call succeeds
-- (the verification step flips enabled = true).

UPDATE ai_model_registry
SET model_id          = 'glm-5.3',
    display_name      = 'Z Code 5.3 (GLM-5.3)',
    tier              = 'CAPABLE',
    compute_class     = 'B',
    context_window    = 1000000,
    target_latency_ms = 3000,
    priority          = 40,
    fallback_list     = '["gemini-3.7-flash"]',
    supports_tools    = true,
    supports_function_calling = true,
    input_cost_per_m  = 0,
    output_cost_per_m = 0,
    health            = 'UNKNOWN'
WHERE provider_id = 'z_code_5_3' AND model_id = 'z-code-5-3';

-- ---------------------------------------------------------------- 4) Ox Alpha — OpenRouter stealth listing
-- Verified route: OpenRouter (https://openrouter.ai/api/v1), model
-- 'stealth/ox-alpha' (revealed architecture: ZAI GLM-5.3-Flash). Auth: the
-- founder's OX_ALPHA_API_KEY holds an OpenRouter sk-or- key. Cost is unknown
-- (0 sentinel; documented COST=UNKNOWN). Disabled until real verification.

INSERT INTO ai_model_registry
  (model_id, provider_id, display_name, tier, compute_class, context_window,
   supports_vision, supports_tools, supports_function_calling,
   input_cost_per_m, output_cost_per_m, entitlement, privacy_class,
   target_latency_ms, health, priority, fallback_list, enabled,
   coding_optimized, capability_category, image_generation, image_editing)
VALUES
  ('stealth/ox-alpha', 'ox_alpha', 'Ox Alpha (OpenRouter)', 'CAPABLE', 'B', 1000000,
   false, true, true, 0, 0, 'FREE', 'STANDARD',
   2500, 'UNKNOWN', 45, '["qwen3.7-plus","gemini-3.7-flash"]', false,
   true, 'MODEL', false, false)
ON CONFLICT (model_id) DO NOTHING;

-- ---------------------------------------------------------------- 5) Manus — external autonomous agent
-- Verified route: Manus v2 async task API (https://api.manus.ai), task
-- lifecycle opposed to a chat model. capability_category = EXTERNAL_AGENT.
-- Disabled until a SAFE read-only verification (we never create an uncontrolled
-- external action just to prove connectivity). Supports only what the verified
-- API provides; no image/tools claims beyond the v2 task rail.

INSERT INTO ai_model_registry
  (model_id, provider_id, display_name, tier, compute_class, context_window,
   supports_vision, supports_tools, supports_function_calling,
   input_cost_per_m, output_cost_per_m, entitlement, privacy_class,
   target_latency_ms, health, priority, fallback_list, enabled,
   coding_optimized, capability_category, image_generation, image_editing)
VALUES
  ('manus-1.6', 'manus', 'Manus 1.6 (External Agent)', 'PREMIUM', 'C', 0,
   false, false, false, 0, 0, 'PRO', 'STRICT',
   0, 'UNKNOWN', 6, '["devin-session"]', false,
   true, 'EXTERNAL_AGENT', false, false)
ON CONFLICT (model_id) DO NOTHING;

-- ---------------------------------------------------------------- 6) provider_health seeds for new providers

INSERT INTO provider_health (provider_id, state)
VALUES ('ox_alpha', 'UNKNOWN'), ('manus', 'UNKNOWN')
ON CONFLICT (provider_id) DO NOTHING;