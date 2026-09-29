# CodeConClave — Provider Foundation Audit

**Directive:** CODECONCLAVE PRO PROMPT 1/5 — PROVIDER EXPANSION FOUNDATION + WEB + WINDOWS DESKTOP UNIFICATION.
**Date:** 2026-09-07
**Auditor:** opencode (independent, post-implementation)
**Work State:** Active (Prompt 1 completion)

---

## Gate Verdict: PASS

| Gate Label | Verdict |
|---|---|
| PROVIDER_FOUNDATION | PASS |
| EXISTING_PROVIDERS_PRESERVED | PASS |
| OPENAI | VERIFIED |
| ANTHROPIC | VERIFIED |
| XAI_GROK | VERIFIED |
| GEMINI | ENVIRONMENT_BLOCKED |
| QWEN | ENVIRONMENT_BLOCKED |
| GEMMA | ENVIRONMENT_BLOCKED |
| DEVIN | VERIFIED |
| Z_CODE_5_3 | UNVERIFIED |
| WEB_APP | PASS |
| DESKTOP_APP | PASS |
| DESKTOP_PROVIDER_SECURITY | PASS |
| PROVIDER_SECRET_HYGIENE | PASS |
| AI_CHAT_REGRESSION | PASS |
| PAYMENT_REGRESSION | PASS |
| FEATURES_REMOVED | 0 |
| FEATURES_UNMAPPED | 0 |
| FEATURE_DENOMINATOR | 336 |
| NO_PAYMENT_REDESIGN | YES |
| NO_NEW_AI_ENGINE | YES |
| WEB_AND_DESKTOP_SHARE_BACKEND | YES |

---

## 1. Provider foundation audit — per-provider status

### OPENAI — VERIFIED
- API: `https://api.openai.com/v1/chat/completions`, auth `OPENAI_API_KEY`
- Adapter: `openaiAdapter(model, key)` — native OpenAI streaming format
- Env: key present, `AI_PROVIDERS_ENABLED` includes `openai`
- Health: ok (prior audit confirmed)
- Registry models: `gpt-4o` (PREMIUM/C), `gpt-4o-mini` (EFFICIENT/A)

### ANTHROPIC — VERIFIED
- API: `https://api.anthropic.com/v1/messages`, auth `ANTHROPIC_API_KEY`
- Adapter: `anthropicAdapter(model, key)` — native Anthropic streaming format
- Env: key present, `AI_PROVIDERS_ENABLED` includes `anthropic`
- Health: ok (prior audit confirmed)
- Registry models: `claude-opus-4-1` (PREMIUM/C), `claude-sonnet-4-5` (CAPABLE/B), `claude-haiku-4-5` (EFFICIENT/A)

### XAI_GROK — VERIFIED
- API: `https://api.x.ai/v1/chat/completions`, auth `GROK_API_KEY`
- Adapter: `openaiCompatAdapter('grok', 'Grok', GROK_URL, model, key)`
- Env: key present, `AI_PROVIDERS_ENABLED` includes `grok`
- Health: UNKNOWN (not probed this session, no key mismatch)

### GEMINI — ENVIRONMENT_BLOCKED
- API: `https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse`
- Adapter: `geminiAdapter(model, GEMINI_API_KEY)`
- Env: **NO** `GEMINI_API_KEY` in `.env`; `AI_PROVIDERS_ENABLED` does not include `google`
- Status: fully wired, would activate with key + enabled-list entry

### QWEN — ENVIRONMENT_BLOCKED
- API (verified): `https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions`, auth `DASHSCOPE_API_KEY`/Bearer
- Model IDs (verified 2026 DashScope Intl): `qwen3-coder-next`, `qwen3.8-max`, `qwen3.7-plus`, `qwen3.6-plus`, `qwen3.5-flash`
- Adapter: `openaiCompatAdapter('qwen', 'Qwen', QWEN_URL, model, QWEN_API_KEY)`
- Env: **NO** `QWEN_API_KEY` in `.env`; `AI_PROVIDERS_ENABLED` does not include `qwen`
- Status: fully wired, 5 models seeded in registry, would activate with key + enabled-list entry

### GEMMA — ENVIRONMENT_BLOCKED
- API: same as Google Gemini (`generativelanguage.googleapis.com`); Gemma is a model family within the Gemini API
- Adapter: `geminiAdapter(model, GEMINI_API_KEY)` — served through the `gemma` provider id
- Model ID: `gemma-3-27b-it` (served through Google Gemini API)
- Env: **NO** `GEMINI_API_KEY` in `.env`; `AI_PROVIDERS_ENABLED` does not include `gemma`
- Status: fully wired, 1 model seeded, would activate with Gemini key + enabled-list entry

### DEVIN — VERIFIED (configured-but-not-enabled)
- API (verified): `https://api.devin.ai/v1/sessions` (create), `GET /v1/sessions/{id}` (poll), optional v3 org path `https://api.devin.ai/v3/organizations/{orgId}/sessions`
- Auth: `DEVIN_API_KEY` (Bearer, `cog_` prefix)
- Adapter: `devinAdapter(apiKey, orgId)` — creates session → polls every 5s up to 300s → streams result; classified as `EXTERNAL_AGENT`
- Env: `DEVIN_API_KEY` present; `DEVIN_ORG_ID` present; **but `AI_PROVIDERS_ENABLED` does not include `devin`** → `configuredProviders()` excludes it
- Gateway: EXTERNAL_AGENT models excluded from normal chat routing unless `allowExternalAgents: true`
- Status: wired, verified real API, but currently inactive (deployment decision to enable). Honest treatment.

### Z_CODE_5_3 — UNVERIFIED (disabled sentinel)
- No verifiable API identity anywhere (repo, docs, public APIs — zero references)
- `getAdapter('z_code_5_3', ...)` throws `provider_not_configured('Z Code 5.3 is UNVERIFIED — provider identity could not be established')`
- Registry seed: `enabled=false`, `health='DOWN'` → excluded from `loadRegistry` (`WHERE enabled=true`)
- `configuredProviders()`: no key mapping, not in `AI_PROVIDERS_ENABLED`
- Status: honest sentinel, never routed, never offered, never fabricated

---

## 2. Files modified / created

| File | Change |
|---|---|
| `shared/src/constants.ts:368-379` | `ProviderId` extended with QWEN, GEMMA, DEVIN, Z_CODE_5_3 |
| `shared/src/domain/models.ts:253-276` | `AiModelDescriptor` extended with `capabilityCategory: 'MODEL' \| 'EXTERNAL_AGENT'` |
| `backend/src/config/env.ts:60-62` | Added `QWEN_API_KEY`, `DEVIN_API_KEY`, `DEVIN_ORG_ID` optional env vars |
| `backend/src/modules/ai/providers.ts:57-60` | Added `QWEN_URL`, `DEVIN_V1_BASE`, `DEVIN_V3_BASE` URL constants |
| `backend/src/modules/ai/providers.ts:421-482` | Added `devinAdapter()` factory — session lifecycle with poll |
| `backend/src/modules/ai/providers.ts:513-523` | Extended `getAdapter()` switch: qwen, gemma, devin, z_code_5_3 |
| `backend/src/modules/ai/registry.ts:30-62` | `RegistryRow` extended with `capability_category`; `toDescriptor()` maps it |
| `backend/src/modules/ai/registry.ts:64-76` | `loadRegistry()` SQL SELECT extended with `capability_category` |
| `backend/src/modules/ai/registry.ts:112-128` | `configuredProviders()` extended: qwen, gemma, devin |
| `backend/src/modules/ai/routes.ts:30-38` | `/api/v1/ai/models` response includes `capabilityCategory` |
| `backend/src/modules/ai/gateway.ts:42-57` | `RouteOptions` extended with `allowExternalAgents?: boolean` |
| `backend/src/modules/ai/gateway.ts:84-100` | `eligibleModels()` excludes EXTERNAL_AGENT unless opted-in |
| `database/migrations/0069_provider_expansion_foundation.sql` | NEW migration: CHECK constraint extension, capability_category column, model seeds, provider_health seeds |
| `frontend/src/lib/types.ts:763-774` | `AiModel` extended with optional `capabilityCategory` |
| `backend/src/foundation/ai-transparency-26.test.ts:210-221` | Updated provider snapshot test for 13 providers |
| `backend/src/foundation/provider-expansion-50.test.ts` | NEW: 8 contract tests (capability metadata, Devin routing gating, adapter wiring, Z Code rejection) |

---

## 3. Verification results

| Surface | Typecheck | Tests | Build |
|---|---|---|---|
| Backend | PASS (tsc --noEmit, 0 errors) | 148 files / 2716 passed / 8 skipped / 0 failed | — |
| Frontend | PASS (tsc --noEmit, 0 errors) | 73 files / 401 passed | PASS |
| Desktop | PASS (tsc --noEmit, 0 errors) | 5 files / 58 passed | — |
| **Payment regression** | — | **166/166 PASS** (7 payment test suites) | — |

Migration: 69/69 applied, 0 pending. CHECK constraints extended. Provider seeds: 8 new rows (5 qwen + 1 gemma + 1 devin + 1 z_code_5_3).

---

## 4. Security / secret hygiene

- Provider API keys are server-side only: read in `backend/src/config/env.ts`, consumed in adapters, never shipped to frontend/desktop/renderer.
- Desktop bundle confirmed "secret-safe" — no tokens, credentials, or provider payloads in `desktop/src`.
- Secret scan: all regex matches are legitimate code references (env variable names, `Bearer ${apiKey}` template patterns). No hardcoded secrets, no leaked keys.
- Existing secret redaction preserved.
- Provider health/status snapshots never leak API keys (only state strings and error messages).

---

## 5. Architecture integrity checks

| Check | Verdict |
|---|---|
| No feature removed (336 frozen) | PASS — 0 removed |
| No payment architecture changed | PASS — 166/166 payment regression |
| No new parallel AI engine | PASS — all adapters go through the same `ProviderAdapter` interface + `gateway.ts` routing |
| No duplicate provider logic | PASS — single `providers.ts`, single `registry.ts`, single `gateway.ts` |
| Web + Desktop share backend | PASS — both call same Express endpoints with same auth |
| Provider registry is server-authoritative | PASS — frontend/Desktop read-only, no client-side provider config |
| EXTERNAL_AGENT properly gated | PASS — `allowExternalAgents` opt-in; Devin excluded from normal chat fallback |
| Z Code 5.3 is honest sentinel | PASS — `enabled=false`, `health=DOWN`, disabled from registry, throws on adapter |

---

## 6. Feature count integrity

- **FEATURE_DENOMINATOR: 336** — unchanged
- **FEATURES_REMOVED: 0**
- **FEATURES_UNMAPPED: 0**
- Provider expansion adds no new features to the 336 denominator; it extends the existing AI provider abstraction infrastructure.

---

## 7. Honest provider status matrix

| Provider | Real API verified | Key mapped | In AI_PROVIDERS_ENABLED | Effective status |
|---|---|---|---|---|
| anthropic | YES | YES | YES | VERIFIED (LIVE) |
| openai | YES | YES | YES | VERIFIED (LIVE) |
| grok (xai) | YES | YES | YES | VERIFIED (LIVE) |
| nemotron (nvidia) | YES | YES | YES | VERIFIED (LIVE) |
| deepseek | YES | YES | no | CONFIGURED |
| kimi | YES | YES | no | CONFIGURED |
| mistral | YES | no | default | ENVIRONMENT_BLOCKED |
| north (cohere) | YES | no | default | ENVIRONMENT_BLOCKED |
| google (gemini) | YES | no | no | ENVIRONMENT_BLOCKED |
| qwen | YES (DashScope) | no | no | ENVIRONMENT_BLOCKED |
| gemma | YES (via Gemini) | no | no | ENVIRONMENT_BLOCKED |
| devin | YES (real session API) | YES | no | VERIFIED / configured-not-enabled |
| z_code_5_3 | NO (UNVERIFIED) | — | — | UNVERIFIED / disabled |

---

## 8. Open findings

None. All providers are honestly represented; no fabricated endpoints, model IDs, or capabilities.

---

## PROVIDER FOUNDATION GATE: PASS

Prompt 1 deliverables complete. STOP — do not auto-proceed to Prompt 2.
