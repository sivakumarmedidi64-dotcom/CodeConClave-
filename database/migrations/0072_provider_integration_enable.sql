-- 0072 Provider Integration Gate — enable verified providers + model alignment
-- -----------------------------------------------------------------------------
-- Prompt 3 outcome (real verification, see docs/CODECONCLAVE_REAL_PROVIDER_VERIFICATION.json)
--   VERIFIED (real call + correct route): google gemini-3.7-flash (text + real
--     multimodal input), qwen3.5-flash, gemma-4-31b-it (Google-served Gemma),
--     gemini-3-pro-image (image generation, present in the live models list).
--   ox_alpha / z_code_5_3 / manus rows stay DISABLED — their real-call
--     credentials did not verify (oka: gate rule = keys must verify first).
--   gemma-3-27b-it is NOT served by this Gemini account (404) — it is disabled
--     and replaced by the actually-served gemma-4-31b-it (honesty alignment,
--     exactly like the z-code-5-3 → glm-5.3 identity fix in 0071).

-- 1) provider_health flip for real-verified integrations.
UPDATE provider_health SET state = 'HEALTHY'
 WHERE provider_id IN ('google', 'qwen', 'gemma');

-- 2) gemma-3-27b-it is 404 on the real account → disable, record honestly.
UPDATE ai_model_registry SET enabled = false, health = 'DOWN'
 WHERE model_id = 'gemma-3-27b-it' AND provider_id = 'gemma';

-- 3) Register the actually-served Gemma variant (gemma-4-31b-it).
INSERT INTO ai_model_registry
  (model_id, provider_id, display_name, tier, compute_class, context_window,
   supports_vision, supports_tools, supports_function_calling,
   input_cost_per_m, output_cost_per_m, entitlement, privacy_class,
   target_latency_ms, health, priority, fallback_list, enabled,
   coding_optimized, capability_category, image_generation, image_editing)
VALUES
  ('gemma-4-31b-it', 'gemma', 'Gemma 4 31B Instruct', 'CAPABLE', 'B', 131072,
   true, false, false, 0.20, 0.60, 'FREE', 'STANDARD',
   2000, 'HEALTHY', 62, '["gemini-3.7-flash"]', true,
   false, 'MODEL', false, false)
ON CONFLICT (model_id) DO NOTHING;

-- 4) Register the verified Gemini image-generation model (found via real
--    ModelService.ListModels). Capability flags make it the IMAGE_GENERATION
--    target for the geminiImageAdapter; router eligibility requires the row to
--    be enabled, so only this verified id is ever reachable.
INSERT INTO ai_model_registry
  (model_id, provider_id, display_name, tier, compute_class, context_window,
   supports_vision, supports_tools, supports_function_calling,
   input_cost_per_m, output_cost_per_m, entitlement, privacy_class,
   target_latency_ms, health, priority, fallback_list, enabled,
   coding_optimized, capability_category, image_generation, image_editing)
VALUES
  ('gemini-3-pro-image', 'google', 'Gemini 3 Pro Image', 'CAPABLE', 'B', 131072,
   true, false, false, 0.02, 0.08, 'PRO', 'STANDARD',
   20000, 'HEALTHY', 35, '[]', true,
   false, 'MODEL', true, true)
ON CONFLICT (model_id) DO NOTHING;