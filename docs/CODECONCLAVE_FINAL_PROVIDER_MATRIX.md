# CodeConClave Pro — FINAL PROVIDER MATRIX (Prompt 5)

Generation: 2026-09-08. Statuses are the honest, non-collapsed states of the
live registry (`ai_model_registry` + `provider_health`) and the real API
results below.

## Matrix

| Provider | Model(s) | Capability | Key State | Health | Real Call | Routing Eligible | Final Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI | gpt-4o, gpt-4o-mini | text+vision | key present (`OPENAI_API_KEY`) | `QUOTA_EXHAUSTED` (429, 7 consecutive failures) | no live positive this sequence | **NO** (health gate) | CONFIGURED / UNVERIFIED — unhealthy |
| Anthropic | claude-opus-4-1, claude-sonnet-4-5, claude-haiku-4-5 | text+vision | key present (`ANTHROPIC_API_KEY`) | `OFFLINE` (400, 7 consecutive failures) | no live positive this sequence | **NO** (health gate) | CONFIGURED / UNVERIFIED — unhealthy |
| xAI Grok | grok-4.3, grok-4.6, grok-build-0.1 | text+vision (grok-build: coding, no vision) | key present (`GROK_API_KEY`) | `REQUIRES_REAUTH` (rejected creds, 11 failures) | no live positive this sequence | **NO** (health gate) | CONFIGURED / UNVERIFIED — unhealthy |
| Gemini (Google) | gemini-3.7-flash (enabled), gemini-2.5-pro (disabled row) | text, vision, reasoning | `VERIFIED` (`GEMINI_API_KEY`) | `HEALTHY` | **REAL: 200** text ×2, **200** multimodal (real PNG input) ×2, **200** models.list | **YES** | VERIFIED |
| Gemma | **gemma-4-31b-it** (enabled, HEALTHY); **gemma-3-27b-it** (disabled, DOWN) | text (Google-served, `GEMINI_API_KEY`) | `VERIFIED` | `HEALTHY` | **REAL: 200** gemma-4-31b-it (after transient timeout/500 retried); **404** gemma-3-27b-it (not served → stays disabled) | **YES** (4-31b) / NO (27b) | VERIFIED (4-31b); DISABLED (27b) — no `GEMMA_API_KEY`, correct |
| Qwen | qwen3.5-flash, qwen3.6-plus, qwen3.7-plus, qwen3.8-max, qwen3-coder-next (coding=true) | text+vision (flash: text-only), coding | `VERIFIED` (`QWEN_API_KEY`) | `HEALTHY` | **REAL: 200** qwen3.5-flash ×2 via canonical adapter (dashscope-intl) | **YES** | VERIFIED |
| Ox Alpha | stealth/ox-alpha (enabled=false) | coding | `KEY_INVALID` (stored key `fk-…`, OpenRouter requires `sk-or-v1-…`) | `UNKNOWN` | Prompt 3 real **401 Missing Authentication header**; adapter verified unchanged (OpenRouter route, Bearer) | **NO** (disabled + key invalid) | KEY_INVALID — founder must replace key |
| Z AI / GLM-5.3 | glm-5.3 (enabled=false) | text (privacy STRICT) | `KEY_INVALID` (stored key is OpenRouter-format, not a Z.ai key) | `DOWN` | Prompt 3 real: HTTP 200 wrapping `{"code":401,"msg":"token expired or incorrect"}`; route `https://api.z.ai/api/v1` + `glm-5.3` verified unchanged | **NO** (disabled + key invalid) | KEY_INVALID — founder must replace key |
| Devin | devin-session (enabled=true) | EXTERNAL_AGENT (autonomous, privacy STRICT) | key present, format valid (`cog_…`, Cognition) | `UNKNOWN` | no live task this gate (task creation forbidden) | **NO** for streaming/text; **YES only** on explicit AUTONOMOUS intent | CONFIGURED (preserved); live-path UNVERIFIED / ENVIRONMENT_BLOCKED |
| Manus | manus-1.6 (enabled=false) | EXTERNAL_AGENT (autonomous, privacy STRICT) | key present (`sk-d…`) | `UNKNOWN` | none (v2 task API has no read-only probe; task creation intentionally forbidden) | **NO** | EXTERNAL_AGENT / ENVIRONMENT_BLOCKED (acceptable honest final state) |
| Big Pickle | — | — | `OPENCODE_ZEN_API_KEY` **absent** from `.env` | — | none | **NO** | NOT INTEGRATED — never advertised |

## Key facts

- All nine Google/Google-served model ids confirmed against a real
  `models.list` (HTTP 200): `gemini-3-pro-image`, `gemini-2.5-flash-image`,
  `gemini-3.1-flash-image`, `gemma-4-31b-it`, `nano-banana-pro-preview`, …;
  `gemma-3-27b-it` is absent — its 404 + disabled row are correct.
- `gemini-3-pro-image` registry row: `image_generation=true`,
  `image_editing=true`, enabled, HEALTHY. The current free-tier key has image-
  generation quota `limit: 0` (real attempt → 429) ⇒ generation is
  environment/billing-blocked until the founder supplies a billing-enabled key.
- Health gate: `computeModelAvailability` excludes DOWN/DEGRADED providers;
  disabled rows (ox_alpha, z_code_5_3, manus, gemma-3-27b-it) are excluded
  from `/models` entirely. No KEY_INVALID/EXTERNAL provider is ever
  auto-selected; pinned-unavailable requests surface honest `agent_not_configured`
  errors.
- Fallbacks verified in registry: ox_alpha → qwen3.7-plus/gemini-3.7-flash;
  glm-5.3 → gemini-3.7-flash; gemma rows → gemini-3.7-flash; devin → (none).
- Fallback audits: resilience-23, stream-hang-21, failure-17, integration-17
  suites all green (timeout→fallback, invalid-key→no retry storm with
  consecutive-failure latching, unavailable→excluded).

Real calls this gate are itemized in `CODECONCLAVE_FINAL_AI_VERIFICATION.md`.
The source of truth for registry rows is the applied migrations
0071–0073 (`docs/`) and `providerKeySpec.ts`.