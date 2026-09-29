# CodeConClave — Provider Registry

**Directive:** CODECONCLAVE PRO PROMPT 1/5 — PROVIDER EXPANSION FOUNDATION.
**Date:** 2026-09-07

## Purpose

The provider registry is the single PostgreSQL-backed catalogue (`ai_model_registry`) that both the Web App and the Windows Desktop App consume. It is the authoritative source of truth for which providers/models exist, their capabilities, entitlements, cost, health, and lifecycle. Nothing is hardcoded in the UI; the backend is the only authority on availability.

## Tables

### `ai_model_registry`
Columns (core): `model_id`, `provider_id`, `display_name`, `tier` (`EFFICIENT|CAPABLE|PREMIUM`), `compute_class` (`A|B|C`), `context_window`, `supports_vision`, `supports_tools`, `supports_function_calling`, `input_cost_per_m`, `output_cost_per_m`, `entitlement` (`FREE|PRO`), `privacy_class` (`PUBLIC|STANDARD|STRICT`), `target_latency_ms`, `health`, `priority`, `fallback_list`, `enabled`, `effective_date`, `deprecation_date`, `coding_optimized`, and (Prompt 1) `capability_category` (`MODEL | EXTERNAL_AGENT`).

- `enabled=false` models are excluded from `getRegistry()` → never routed, never offered.
- Deprecated models (`deprecation_date < CURRENT_DATE`) are excluded.

### `provider_health`
Per-provider probe state: `UNKNOWN | HEALTHY | DEGRADED | DOWN | BLOCKED` plus `last_check_at`, `last_error`, success/failure counts, latency EMA. Updated by `updateProviderHealth()` after each inference.

### `model_usage_logs`
Every inference records provider/model/tokens/cost/fallback/duration/tenant/coworker — the audit rail for cost and transparency.

## Registry load path

```
loadRegistry()  →  queryMany(SELECT … WHERE enabled=true AND (deprecation_date IS NULL OR deprecation_date > CURRENT_DATE) ORDER BY priority)
     ↓
refreshProviderHealth()  (overlay provider_health.state onto each model's health)
     ↓
toDescriptor()  →  AiModelDescriptor (shared type) incl. capabilityCategory
```

`RegistryRow` interface (backend) carries `capability_category`; `toDescriptor()` maps it to `AiModelDescriptor.capabilityCategory` (default `'MODEL'`). `getRegistry()` is memoized and refreshed per `AI_MODEL_REFRESH_MINUTES`.

## `ProviderId` enum (shared `shared/src/constants.ts`)

Extended with `QWEN='qwen'`, `GEMMA='gemma'`, `DEVIN='devin'`, `Z_CODE_5_3='z_code_5_3'`. The full provider id set now:

`anthropic, openai, google, mistral, grok, deepseek, kimi, nemotron, north, qwen, gemma, devin, z_code_5_3`

## Seeded models (Prompt 1 foundation)

### Qwen (providerId `qwen`) — OpenAI-compatible, DashScope Intl
| model_id | tier | compute | vision | tools | cost in/out per M | privacy |
|---|---|---|---|---|---|---|
| `qwen3-coder-next` | CAPABLE | B | ✓ | ✓ | 0.20 / 0.50 | STANDARD |
| `qwen3.8-max` | PREMIUM | C | ✓ | ✓ | 1.00 / 3.00 | STANDARD |
| `qwen3.7-plus` | CAPABLE | B | ✓ | ✓ | 0.50 / 1.50 | STANDARD |
| `qwen3.6-plus` | CAPABLE | B | ✓ | ✓ | 0.60 / 1.80 | STANDARD |
| `qwen3.5-flash` | EFFICIENT | A | ✓ | ✓ | 0.20 / 0.60 | STANDARD |

Model ids are the **verified** 2026 DashScope Intl ids (`qwen3-coder-next`, `qwen3.8-max`, `qwen3.7-plus`, `qwen3.6-plus`, `qwen3.5-flash`).

### Gemma (providerId `gemma`) — served via Google Gemini API
| model_id | provider | tier | compute | notes |
|---|---|---|---|---|
| `gemma-3-27b-it` | `gemma` | CAPABLE | B | served through Google `generativelanguage.googleapis.com` using `GEMINI_API_KEY`; `supportsVision=true`, `supportsTools=false` |

Gemma is not a standalone provider; it is a model family reached through the Google Gemini adapter (`geminiAdapter`) under the `gemma` provider id.

### Devin (providerId `devin`) — external agent
| model_id | provider | tier | compute | capability_category |
|---|---|---|---|---|
| `devin-session` | `devin` | PREMIUM | C | `EXTERNAL_AGENT` |

`costs 0` (usage is metered by the Devin platform, not ours), `entitlement PRO`, `privacy_class STRICT`. Routed only when `allowExternalAgents: true`; never a chat fallback.

### Z Code 5.3 (providerId `z_code_5_3`) — UNVERIFIED sentinel
| model_id | provider | enabled | health |
|---|---|---|---|
| `z-code-5-3` | `z_code_5_3` | `false` | `DOWN` |

Disabled + DOWN → excluded from the live registry, never routed, `getAdapter` throws. Honest non-fabrication of an unverifiable provider.

## `configuredProviders()` (backend `registry.ts`)

```
keyByProvider = { anthropic: env.ANTHROPIC_API_KEY, openai: env.OPENAI_API_KEY, google: env.GEMINI_API_KEY,
  mistral: env.MISTRAL_API_KEY, grok: env.GROK_API_KEY, deepseek: env.DEEPSEEK_API_KEY, kimi: env.KIMI_API_KEY,
  nemotron: env.NVIDIA_API_KEY, north: env.COHERE_API_KEY, qwen: env.QWEN_API_KEY, gemma: env.GEMINI_API_KEY,
  devin: env.DEVIN_API_KEY }
return enabledProviders.filter(p => keyByProvider[p])
```

A provider is "configured" only if it is in `AI_PROVIDERS_ENABLED` AND has a key. Note: `gemma` and `google` share `GEMINI_API_KEY`; `devin` maps `DEVIN_API_KEY`.

## Availability semantics (server-authoritative)

In `GET /api/v1/ai/models`, a model is `available` only when:
1. its provider is in `configuredProviders()`, AND
2. health is neither `DOWN` nor `DEGRADED`, AND
3. for premium compute, the daily Pro budget is not exhausted.

`locked=true` when a PRO-only model is viewed by a free user. The client cannot override any of this.

## Verification

- Backend typecheck: PASS after registry edits.
- Existing gateway/provider tests: 66/66 PASS (ai-gateway-5 36, gateway-25 18, model-gateway 12).
- Migration `0069` applied: 69/69, 0 pending.
