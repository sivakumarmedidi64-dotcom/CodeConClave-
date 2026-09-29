-- 0129: Correct factual defects in 0128_model_seeds.sql (already applied).
-- Applied in-place against the live DB rows, idempotent, and designed to be
-- a no-op on fresh databases where the corrected 0128 source is installed.
--
-- Defects fixed:
--  1) Slash-prefixed ids are NVIDIA NIM routes consumed by the 'nemotron'
--     provider; 0128 incorrectly mapped kimi-k3/gemma-4-31b-it/gpt-oss-120b
--     to the kimi/gemma/north providers (separate first-party endpoints).
--  2) capability_category stored free-form values (REASONING/CODING/
--     MULTIMODAL/GENERAL/LIGHTWEIGHT) that violate the shared
--     'MODEL' | 'EXTERNAL_AGENT' contract exposed to the frontend.
--  3) Google/gemini rows advertised supports_tools/supports_function_calling
--     while the google adapter implements no typed tool-call flow
--     (geminiAdapter.supportsToolCalls = false) — now presented honestly.

-- 1) Provider remap (NVIDIA NIM default model ids)
UPDATE ai_model_registry
   SET provider_id = 'nemotron'
 WHERE model_id IN ('moonshotai/kimi-k3','google/gemma-4-31b-it','openai/gpt-oss-120b')
   AND provider_id <> 'nemotron';

-- 2) capability_category must be 'MODEL' | 'EXTERNAL_AGENT' for every seeded row
UPDATE ai_model_registry
   SET capability_category = 'MODEL'
 WHERE model_id IN (
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
 )
   AND capability_category NOT IN ('MODEL','EXTERNAL_AGENT');

-- 3) Google rows: honest capability flags (google adapter has no typed tool-call flow)
UPDATE ai_model_registry
   SET supports_tools = false,
       supports_function_calling = false
 WHERE provider_id = 'google'
   AND model_id IN ('gemini-3.8-flash','gemini-3.7-flash','gemini-3.6-flash','gemini-3.1-flash-lite')
   AND (supports_tools = true OR supports_function_calling = true);