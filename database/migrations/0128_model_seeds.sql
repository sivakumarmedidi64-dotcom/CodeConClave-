-- 0128: Provider expansion — seed 10 free-tier model entries
-- All models use existing free-tier credentials (Google, NVIDIA NIM, Mistral)
-- Context windows and capabilities based on current provider documentation
--
-- Corrected (see 0129 for the live-DB backfill):
--  * slash-prefixed ids (moonshotai/*, google/*, openai/*) are NVIDIA NIM
--    routes served by the 'nemotron' provider, not kimi/gemma/north.
--  * capability_category is the shared 'MODEL' | 'EXTERNAL_AGENT' contract.
--  * google/gemini rows are honest: the google adapter has no typed tool-call
--    flow, so supports_tools/supports_function_calling are false.

-- Clear any existing entries for these model_ids (idempotent)
DELETE FROM ai_model_registry WHERE model_id IN (
  'nvidia/nemotron-3-ultra-550b-a55b',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'moonshotai/kimi-k3',
  'google/gemma-4-31b-it',
  'openai/gpt-oss-120b',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.1-flash-lite',
  'mistral-small-4'
);

-- Insert 10 free-tier model entries
INSERT INTO ai_model_registry (
  model_id, provider_id, display_name, tier, compute_class,
  context_window, supports_vision, supports_tools, supports_function_calling,
  input_cost_per_m, output_cost_per_m, entitlement, privacy_class,
  target_latency_ms, health, priority, fallback_list, enabled,
  effective_date, deprecation_date, coding_optimized, capability_category,
  image_generation, image_editing
) VALUES
-- 1. Nemotron 3 Ultra 550B — primary reasoning/coding/planning
('nvidia/nemotron-3-ultra-550b-a55b', 'nemotron', 'Nemotron 3 Ultra 550B', 'CAPABLE', 'B',
 1048576, false, true, true, 0, 0, 'PRO', 'STANDARD', 5000, 'UNKNOWN', 10, '["gemini-3.8-flash","mistral-small-4"]', true,
 CURRENT_DATE, null, true, 'MODEL', false, false),

-- 2. Nemotron 3.5 Lightning 30B — fast execution/agent tasks
('nvidia/nemotron-3.5-lightning-30b-a3b', 'nemotron', 'Nemotron 3.5 Lightning 30B', 'EFFICIENT', 'A',
 1048576, false, true, true, 0, 0, 'PRO', 'STANDARD', 2000, 'UNKNOWN', 20, '["nvidia/nemotron-3-ultra-550b-a55b","gemini-3.7-flash"]', true,
 CURRENT_DATE, null, true, 'MODEL', false, false),

-- 3. Kimi K3 (Moonshot) — multimodal/long-horizon coding/agentic (NVIDIA NIM)
('moonshotai/kimi-k3', 'nemotron', 'Kimi K3', 'CAPABLE', 'B',
 1048576, true, true, true, 0, 0, 'PRO', 'STANDARD', 5000, 'UNKNOWN', 30, '["gemini-3.8-flash","nvidia/nemotron-3-ultra-550b-a55b"]', true,
 CURRENT_DATE, null, false, 'MODEL', false, false),

-- 4. Gemma 4 31B — vision/reasoning/multimodal (NVIDIA NIM)
('google/gemma-4-31b-it', 'nemotron', 'Gemma 4 31B', 'CAPABLE', 'B',
 262144, true, true, true, 0, 0, 'PRO', 'STANDARD', 5000, 'UNKNOWN', 40, '["gemini-3.8-flash","moonshotai/kimi-k3"]', true,
 CURRENT_DATE, null, false, 'MODEL', false, false),

-- 5. GPT-OSS 120B — reasoning/coding/structured tool workflows (NVIDIA NIM)
('openai/gpt-oss-120b', 'nemotron', 'GPT-OSS 120B', 'CAPABLE', 'B',
 131072, false, true, true, 0, 0, 'PRO', 'STANDARD', 5000, 'UNKNOWN', 50, '["nvidia/nemotron-3-ultra-550b-a55b","gemini-3.8-flash"]', true,
 CURRENT_DATE, null, true, 'MODEL', false, false),

-- 6. Gemini 3.8 Flash — primary general/long-horizon agent
('gemini-3.8-flash', 'google', 'Gemini 3.8 Flash', 'CAPABLE', 'B',
 1048576, true, false, false, 0, 0, 'FREE', 'STANDARD', 3000, 'UNKNOWN', 5, '["nvidia/nemotron-3-ultra-550b-a55b","mistral-small-4"]', true,
 CURRENT_DATE, null, false, 'MODEL', false, false),

-- 7. Gemini 3.7 Flash — coding/agent fallback
('gemini-3.7-flash', 'google', 'Gemini 3.7 Flash', 'CAPABLE', 'B',
 1048576, true, false, false, 0, 0, 'FREE', 'STANDARD', 3000, 'UNKNOWN', 10, '["gemini-3.6-flash","nvidia/nemotron-3.5-lightning-30b-a3b"]', true,
 CURRENT_DATE, null, true, 'MODEL', false, false),

-- 8. Gemini 3.6 Flash — general fallback/high throughput
('gemini-3.6-flash', 'google', 'Gemini 3.6 Flash', 'EFFICIENT', 'A',
 1048576, true, false, false, 0, 0, 'FREE', 'STANDARD', 2000, 'UNKNOWN', 20, '["gemini-3.1-flash-lite","gemini-3.7-flash"]', true,
 CURRENT_DATE, null, false, 'MODEL', false, false),

-- 9. Gemini 3.1 Flash-Lite — lightweight/routing/classification/fast
('gemini-3.1-flash-lite', 'google', 'Gemini 3.1 Flash-Lite', 'EFFICIENT', 'A',
 1048576, true, false, false, 0, 0, 'FREE', 'STANDARD', 1500, 'UNKNOWN', 30, '["gemini-3.6-flash"]', true,
 CURRENT_DATE, null, false, 'MODEL', false, false),

-- 10. Mistral Small 4 — general coding/reasoning fallback
('mistral-small-4', 'mistral', 'Mistral Small 4', 'EFFICIENT', 'A',
 262144, false, true, true, 0, 0, 'FREE', 'STANDARD', 2000, 'UNKNOWN', 40, '["gemini-3.6-flash","gemini-3.7-flash"]', true,
 CURRENT_DATE, null, true, 'MODEL', false, false);