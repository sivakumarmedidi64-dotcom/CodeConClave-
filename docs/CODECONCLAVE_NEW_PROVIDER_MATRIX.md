# CodeConClave Pro — New Provider Matrix (Pre-Prompt 3 Gate)

**Directive:** CODECONCLAVE PRO — PROVIDER KEY PREPARATION + API ROUTE VERIFICATION (Pre-Prompt 3 Provider Configuration Gate).
**Date:** 2026-09-08
**Source of truth:** `backend/src/modules/ai/providerKeySpec.ts` (tests assert this document's data).

## Status legend
- **VERIFIED** = identity + API route + auth confirmed from vendor/official docs AND a real call performed.
- **ENVIRONMENT_BLOCKED (EB)** = verified identity/route/auth, but the API key is absent in this environment → no real call performed.
- **UNVERIFIED** = identity could not be established (keys for these are NEVER stored).

All seven providers below are `ENVIRONMENT_BLOCKED` because **no key is installed** — real-call VERIFICATION
is deliberately deferred until keys are provided (Prompt 3).

## Matrix (the seven requested providers)

| # | Provider | Status | API key variable | Key source | Base URL | Model ID(s) | Capability | Real call | Env blocked |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Google Gemini | EB | `GEMINI_API_KEY` | Google AI Studio / Vertex | `https://generativelanguage.googleapis.com/v1beta` | `gemini-3.7-flash` (enabled), `gemini-2.5-pro` (disabled) | MODEL | NO | YES |
| 2 | Qwen | EB | `QWEN_API_KEY` | Alibaba Model Studio / DashScope Intl | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions` | `qwen3.8-max`, `qwen3.7-plus`, `qwen3-coder-next`, `qwen3.6-plus`, `qwen3.5-flash` (all seeded + enabled) | MODEL | NO | YES |
| 3 | Gemma | EB | `GEMINI_API_KEY` (no separate GEMMA key) | Same as Google Gemini | `https://generativelanguage.googleapis.com/v1beta` | `gemma-3-27b-it` (seeded, enabled; health DOWN w/o key) | MODEL | NO | YES |
| 4 | Manus AI | EB | `MANUS_API_KEY` | Manus developer platform (manus.ai) | `https://api.manus.ai` (v2 async task API) | `manus-1.6`, `manus-1.6-lite`, `manus-1.6-max` | **EXTERNAL_AGENT** | NO | YES |
| 5 | Ox Alpha | EB | `OX_ALPHA_API_KEY` (value = **OpenRouter** `sk-or-` key) | OpenRouter keys page (no first-party Ox Alpha dashboard) | `https://openrouter.ai/api/v1` (OpenAI-compatible) | `stealth/ox-alpha` (revealed ZAI GLM-5.3-Flash) | MODEL | NO | YES |
| 6 | Big Pickle | EB (production NOT recommended) | `OPENCODE_ZEN_API_KEY` — **DO NOT ADD YET** | OpenCode Zen account + billing | `https://opencode.ai/zen/v1` (OpenAI-compatible) | `big-pickle` | MODEL | NO | YES |
| 7 | Z Code 5.3 (Z.ai GLM-5.3 / ZCode) | EB | `Z_AI_API_KEY` | Z.ai platform + GLM Coding Plan | `https://api.z.ai/api/v1` (also `/api/paas/v4`, `/api/anthropic`) | `glm-5.3` (⚠️ seeded row says `z-code-5-3` — mismatch to fix in Prompt 3) | MODEL | NO | YES |

## Key facts per provider

- **Gemini** — existing adapter + wired; only the key is missing. Gemini 3.6/3.5/3.1 Flash & 3.1 Pro are newer official families; image-gen is a separate track (Nano Banana 2, `gemini-3-pro-image`).
- **Qwen** — adapter + 5 verified seeded models; only `QWEN_API_KEY` missing. Thinking defaults ON for qwen3.7/3.8 families; `qwen3-coder-next` is the coding id.
- **Gemma** — reached **through Google's API**; `GEMINI_API_KEY` serves both `google` and `gemma`. Newer `gemma-4-*` variants exist but are not seeded.
- **Manus** — **EXTERNAL_AGENT** (autonomous task API), like Devin: async task lifecycle, `x-manus-api-key` or OAuth (`create_task`, `manage_all_tasks`). Requires `allowExternalAgents` at call time — never a chat fallback.
- **Ox Alpha** — stealth listing on OpenRouter, revealed to be a Z.ai GLM-5.3-Flash rebrand; anonymous developer, no first-party offering. Key is an OpenRouter key; `sk-or-v1-` pattern added to the secret guard.
- **Big Pickle** — OpenCode Zen gateway model, **NOT production-ready** (free smoke-test tier; some aggregators list it disabled since 2026-08-14). Kept comment-only: `DO NOT ADD OPENCODE_ZEN_API_KEY YET`.
- **Z Code 5.3** — **real** (Z.ai GLM-5.3, 1M ctx, reasoning low/high/max); ⚠️ seeded `z-code-5-3` model id ≠ vendor `glm-5.3`; row disabled, must be aligned at Prompt 3.

## Existing providers (preserved, unchanged)

| Provider | Adapter | Seeded models (enabled today) | Current health probe |
|---|---|---|---|
| anthropic | ✓ | claude-opus-4-1, claude-sonnet-4-5, claude-haiku-4-5 | OFFLINE (key present) |
| openai | ✓ | gpt-4o, gpt-4o-mini | QUOTA_EXHAUSTED (key present) |
| grok | ✓ | grok-4.6, grok-4.3, grok-build-0.1 | REQUIRES_REAUTH (key present) |
| nemotron (north-group NVIDIA) | ✓ | nemotron-3-ultra/super/3.5-lightning/nano (default `nvidia/nemotron-3.5-lightning-30b-a3b`) | HEALTHY (key present) |
| deepseek | ✓ | deepseek-v4-pro, deepseek-v4-flash | — |
| kimi | ✓ | kimi-k3, kimi-k2.7-code(-highspeed), kimi-k2.6 | — |
| mistral | ✓ | mistral-large-2411 | — |
| north | ✓ | north-mini-code-1.0 | — |
| devin | ✓ (EXTERNAL_AGENT) | devin-session | UNKNOWN (key present, not in allow-list) |
| google | ✓ | gemini-3.7-flash | DOWN (no key) |
| qwen | ✓ | 5 qwen3.* models | DOWN (no key) |
| gemma | ✓ | gemma-3-27b-it | DOWN (no key) |
| z_code_5_3 | — (Prompt 3) | `z-code-5-3` (disabled; id mismatch) | DOWN (sentinel row) |

Preservation guarantee: this gate changed **no shared constants, no migration, no registry seeds, no adapter
switch**, and `configuredProviders()` now delegates to a strict pure parser whose behavior is identical in
this environment. `AI_PROVIDERS_ENABLED=anthropic,openai,grok,nemotron` is untouched, so the live routing
pool is byte-for-byte the same as before.

## Routing + client compatibility

- Web and Desktop both consume the **same server-authoritative** `/api/v1/ai/models` and `/api/v1/ai/providers`
  contracts; availability is derived from `configuredProviders()` ∩ registry health via
  `computeModelAvailability()` (shared predicate, unit-tested). No client holds or can inject a key.
- None of the four adapter-less new ids (`ox_alpha`, `manus`, `big_pickle`, `z_code_5_3`) is reported
  configured, so nothing new is routable or advertised — the model routing allow-list is unchanged.
- Payment architecture is FROZEN (regression-only this gate).