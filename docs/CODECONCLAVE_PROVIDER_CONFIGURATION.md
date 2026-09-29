# CodeConClave — Provider Configuration

**Directive:** CODECONCLAVE PRO PROMPT 1/5 — PROVIDER EXPANSION FOUNDATION.
**Date:** 2026-09-07

## How providers are configured

Provider configuration is entirely server-side, expressed through environment variables read in `backend/src/config/env.ts` and consumed by `configuredProviders()` in `backend/src/modules/ai/registry.ts`. There is **no client-side provider configuration** — neither the Web App nor the Desktop App can enable/disable/connect a provider. This keeps secrets server-side and availability server-authoritative.

## Env schema (AI keys)

```env
# Existing (unchanged)
ANTHROPIC_API_KEY
OPENAI_API_KEY
GEMINI_API_KEY
MISTRAL_API_KEY
GROK_API_KEY
DEEPSEEK_API_KEY
KIMI_API_KEY
NVIDIA_API_KEY
COHERE_API_KEY

# Added by Prompt 1
QWEN_API_KEY           # optional, DashScope Intl Bearer key
DEVIN_API_KEY          # optional, Devin cog_ Bearer key
DEVIN_ORG_ID           # optional, Devin organization id (enables /v3 org sessions)

# Gating
AI_PROVIDERS_ENABLED   # comma-separated allow-list of provider ids (also the routing allow-list)
AI_DEFAULT_MODEL       # server-level default model id
AI_PREMIUM_BUDGET_USD_PER_DAY
AI_MODEL_REFRESH_MINUTES
AI_REQUEST_TIMEOUT_MS
AI_CHAIN_TIMEOUT_MS
```

`GEMINI_API_KEY` serves **both** the `google` provider and the `gemma` provider family (Gemma is reached through Google's LLM API). The `gemma` entry in `keyByProvider` maps to `env.GEMINI_API_KEY`.

The `z_code_5_3` provider has **no** key mapping by design — it is unverified and disabled.

## Effective status for each provider (this environment, 2026-09-07)

`.env` present keys (AI): `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GROK_API_KEY`, `DEVIN_API_KEY`, plus `DEEPSEEK/KIMI/NVIDIA` (from earlier config) and `AI_PROVIDERS_ENABLED=anthropic,openai,grok,nemotron`.

| Provider | Key present | In `AI_PROVIDERS_ENABLED` | Effective | Health probe |
|---|---|---|---|---|
| OPENAI | ✅ | ✅ | **LIVE** (a.k.a. VERIFIED) | ok |
| ANTHROPIC | ✅ | ✅ | **LIVE** (a.k.a. VERIFIED) | ok |
| XAI/GROK | ✅ | ✅ | CONFIGURED | UNKNOWN (not probed this session) |
| NVIDIA (nemotron) | ✅ | ✅ | LIVE (default model) | verified earlier session |
| GEMINI (`google`) | ❌ | ❌ | ENVIRONMENT_BLOCKED | — |
| GEMMA | ❌ (needs GEMINI_API_KEY) | ❌ | ENVIRONMENT_BLOCKED | — |
| QWEN | ❌ (needs QWEN_API_KEY) | ❌ | ENVIRONMENT_BLOCKED | UNKNOWN |
| DEVIN | ✅ | ❌ (wired, not enabled) | **VERIFIED** / configured-but-not-enabled | UNKNOWN |
| Z_CODE_5_3 | — | ❌ | **UNVERIFIED** (disabled sentinel) | DOWN |

### Notes
- **Qwen** and **Gemma** are fully wired into the adapters and registry but are `ENVIRONMENT_BLOCKED` in this environment solely because no API key is configured. Adding `QWEN_API_KEY` (and including `qwen` in `AI_PROVIDERS_ENABLED`) activates the 5 verified qwen3 models; adding `GEMINI_API_KEY` + `gemma` in the allow-list activates `gemma-3-27b-it`.
- **Devin** has a key present and is wired, but `AI_PROVIDERS_ENABLED` does not include `devin`, so it is configured-but-not-enabled. It would additionally require `allowExternalAgents: true` at the task/coworker call site to be routed (never a chat fallback).
- No provider endpoint, model ID, or capability was invented.

## Example to enable Qwen

```env
AI_PROVIDERS_ENABLED=anthropic,openai,grok,nemotron,qwen
QWEN_API_KEY=<DashScope Intl DASHSCOPE key>
```

## Example to enable Gemma

```env
AI_PROVIDERS_ENABLED=anthropic,openai,grok,nemotron,gemma
GEMINI_API_KEY=<Google Gemini key>   # also enables the google provider
```

## Security & secret hygiene

- Keys are read only on the server; they never appear in frontend bundles, `localStorage`, the Electron renderer/preload, logs, audit payloads, API responses, or model prompts.
- Existing secret redaction is preserved. See `CODECONCLAVE_PROVIDER_FOUNDATION_AUDIT.md` for the secret-scan results.
- Always validate config by running the backend typecheck and the AI regression tests after changing env.
