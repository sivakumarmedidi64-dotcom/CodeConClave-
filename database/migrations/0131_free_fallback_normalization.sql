-- 0131: FREE-primary fallback normalization (hygiene, no behavior change).
-- The live gateway re-ranks via eligibleModels and ignores fallback_list, but
-- any future direct consumer must never route a FREE primary to a PRO fallback
-- (entitlement_mismatch). Normalize FREE primaries to FREE-only fallbacks.
-- PRO primaries keep cross-tier fallbacks (paid users may use either).

UPDATE ai_model_registry
SET fallback_list = '["mistral-small-4","gemini-3.7-flash"]'::jsonb
WHERE model_id = 'gemini-3.8-flash';

UPDATE ai_model_registry
SET fallback_list = '["gemini-3.6-flash","mistral-small-4"]'::jsonb
WHERE model_id = 'gemini-3.7-flash';

UPDATE ai_model_registry
SET fallback_list = '["gemini-3.6-flash","mistral-small-4"]'::jsonb
WHERE model_id = 'gemini-3.1-flash-lite';
