# CodeConClave — Provider Architecture Baseline

**Directive:** CODECONCLAVE PRO PROMPT 1/5 — PROVIDER EXPANSION FOUNDATION + WEB + WINDOWS DESKTOP UNIFICATION.
**Date:** 2026-09-07
**Work State:** Active (Prompt 1)

This document captures the pre-existing provider architecture (the "baseline") and the provider-expansion foundation layer added on top for Prompt 1. It is the authoritative reference for how CodeConClave selects, routes, health-tracks, streams, and cost-audits AI providers across **both** the Web App and the Windows Desktop App.

## 1. Unified backend model (Web + Desktop share one backend)

CodeConClave has a single Node/Express backend (`backend/`) that is consumed by:

- **Web App** (`frontend/`) — browser SPA reading `/api/v1/ai/*` over the same `cc_session` httpOnly cookie.
- **Windows Desktop App** (`desktop/`) — Electron thin client (`desktop/src/cloud/client.ts`) that talks to the **same backend** with the same session cookie. It is read-mostly in its foundation and never maintains a second state model (`desktop/src/desktop/app.ts` notes "no second state model").

Because both surfaces call the same Express server, **provider selection, routing, health, entitlement, and cost are identical** for Web and Desktop. There is exactly one provider registry, one gateway, one audit store. This is `WEB_AND_DESKTOP_SHARE_BACKEND=YES`.

Provider API keys are **server-side only**. They live in `backend` env, are read in `backend/src/config/env.ts`, and are never shipped in frontend bundles, the local agent, or the Electron renderer/preload. The desktop bundle is "secret-safe: no tokens, credentials, provider payloads" (`desktop/src/types.ts`).

## 2. Provider adapter layer (`backend/src/modules/ai/providers.ts`)

Every provider is wrapped in a normalized `ProviderAdapter`:

```ts
interface ProviderAdapter {
  providerId: string;
  supportsToolCalls: boolean;
  complete(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatChunk>;
}
```

- `ChatMessage`: `{ role: 'user'|'assistant'|'system', content }`
- `ChatRequest`: `{ messages, maxTokens?, temperature? }`
- `ChatChunk`: `{ delta, inputTokens?, outputTokens? }` — every adapter streams deltas.

Adapters produce SSE deltas via `AsyncGenerator<ChatChunk>`, report latency + health honestly, and classify failures into the shared fallback-reason taxonomy (`classifyProviderError` → `deriveStatusFromFailure`).

`getAdapter(providerId, model)` is a switch over provider ids; any unconfigured provider throws `AppError.unavailable('provider_not_configured', …)`.

## 3. Registry (PostgreSQL-backed catalogue) — `backend/src/modules/ai/registry.ts`

- Table `ai_model_registry` holds the full model catalogue.
- `getRegistry()` (cached, refreshed per `AI_MODEL_REFRESH_MINUTES`) returns `AiModelDescriptor[]` for every `enabled=true`, non-deprecated model.
- `AiModelDescriptor` (shared `shared/src/domain/models.ts`) now carries `capabilityCategory: 'MODEL' | 'EXTERNAL_AGENT'` (added in Prompt 1).
- `configuredProviders()` returns providers that are **both** listed in `AI_PROVIDERS_ENABLED` **and** have a configured API key. This is the honest "can I even talk to this provider" truth.
- `provider_health` table records per-provider probe state (`UNKNOWN/HEALTHY/DEGRADED/DOWN/BLOCKED`) and is overlaid onto registry health.

## 4. Gateway routing + compute governance — `backend/src/modules/ai/gateway.ts`

`eligibleModels(userId, opts)` filters the registry by:

1. Health (`DOWN`/`DEGRADED` excluded)
2. Entitlement (PRO models gated for free plan)
3. `configuredProviders()` membership
4. **Capability category** — `EXTERNAL_AGENT` models are excluded unless `opts.allowExternalAgents` is true (Prompt 1 addition; keeps Devin out of normal chat fallback)
5. Tool/function-calling/vision capability, context window, privacy class, latency, premium exclusion, free-plan tier rules

`routeModels()` returns `{ primary, fallback, tertiary }` and throws an honest `no_model_available` error only when nothing qualifies.

Every inference writes a `model_usage_logs` row (provider, model, tokens, cost, fallback reason, duration, tenant, coworker).

## 5. Transparency — `backend/src/modules/ai/status.ts`, `routes.ts`

- `GET /api/v1/ai/models` — server-authoritative selectable list (`available`, `locked`, `overBudget`, plus new `capabilityCategory`). The client cannot override server availability.
- `GET /api/v1/ai/providers` — per-provider honest status snapshot (`providerStatusSnapshot`), iterating `Object.values(ProviderId)` so new providers appear automatically.
- `GET /api/v1/ai/usage` — today's usage by provider/model + a transparency trail showing fallbacks.

## 6. Baseline provider set (pre-Prompt 1: 9 providers)

Registered providers before Prompt-1 foundation work: `anthropic`, `openai`, `google`, `mistral`, `grok`, `deepseek`, `kimi`, `nemotron`, `north`.

Registry model seeds (from `0001`…`0042` migrations): Claude Opus/Sonnet/Haiku, GPT-4o / GPT-4o mini, Gemini Pro / Gemini Flash, Mistral Large, plus Stage-25 additions.

Postgres `CHECK` constraints in `0042_stage25_product_expansion.sql:9-15` restricted `provider_id IN ('anthropic','openai','google','mistral','grok','deepseek','kimi','nemotron','north')` on both `ai_model_registry` and `provider_health`.

## 7. Provider expansion foundation (Prompt 1 additions)

New providers added behind the SAME adapter/registry/gateway — **no parallel AI engine, no duplicated provider logic**:

| Provider ID | Adapter backing | Real API (verified) | Model family (seeded) |
|---|---|---|---|
| `qwen` | `openaiCompatAdapter` → `QWEN_URL` (DashScope compatible-mode) | Qwen (DashScope Intl), auth `DASHSCOPE_API_KEY`/Bearer | `qwen3-coder-next`, `qwen3.8-max`, `qwen3.7-plus`, `qwen3.6-plus`, `qwen3.5-flash` |
| `gemma` | `geminiAdapter` (Google Gemini HTTP) | Google `generativelanguage.googleapis.com` | `gemma-3-27b-it` |
| `devin` | `devinAdapter` (external agent session lifecycle) | Devin real API (v1/v3 sessions + poll) | `devin-session` (`capability_category='EXTERNAL_AGENT'`) |
| `z_code_5_3` | none — honest disabled sentinel | **UNVERIFIED** — no verifiable API identity anywhere | `z-code-5-3` (`enabled=false`, `health='DOWN'`) |

### 7.1 Devin external-agent adapter
`devinAdapter(apiKey, orgId)` implements `complete()` as an out-of-band job lifecycle mapped onto the chat interface:
- `POST /v1/sessions` (or `/v3/organizations/{orgId}/sessions`) → returns `session_id`.
- Poll `GET /v1/sessions/{id}` (or v3 org variant) every 5s up to 300s.
- On `status_enum === 'finished'`, yield the last assistant message / structured output.
- On `status_enum === 'blocked'`, throw `provider_error`; on poll timeout, throw `provider_timeout`.

Because Devin is `capabilityCategory='EXTERNAL_AGENT'`, the gateway **excludes it from normal chat routing** unless `allowExternalAgents: true` — it is opt-in via explicit task/coworker execution, never a silent fallback.

### 7.2 Z Code 5.3 honest sentinel
Z Code 5.3 could not be verified (zero references in repo, docs, or public APIs). It is therefore:
- Registered as `enabled=false`, `health='DOWN'` → excluded from `loadRegistry` (no `WHERE enabled=true`) → never routed, never offered to any user.
- `getAdapter('z_code_5_3', …)` throws `provider_not_configured('Z Code 5.3 is UNVERIFIED …')`.
- `configuredProviders()` never maps a key for it.

This is the honest, non-fabricating treatment mandated by the directive ("never invent an endpoint/model ID/capability").

## 8. Migration `0069_provider_expansion_foundation.sql`

Extends the `0042` CHECK constraints to `('anthropic','openai','google','mistral','grok','deepseek','kimi','nemotron','north','qwen','gemma','devin','z_code_5_3')` on both `ai_model_registry` and `provider_health`; adds `capability_category text NOT NULL DEFAULT 'MODEL'`; seeds the qwen/gemma/devin/z_code_5_3 registry rows and `provider_health` rows. All inserts are `ON CONFLICT (model_id) DO NOTHING`. Applied successfully → 69/69 migrations, 0 pending.

## 9. Frontend + desktop integration

- `frontend/src/lib/types.ts` `AiModel` gained optional `capabilityCategory` — reads whatever the backend returns; the UI is fully dynamic.
- `ModelPicker.tsx` honors server `available`/`locked`/`health`; EXTERNAL_AGENT and unconfigured models are non-selectable.
- Desktop consumes the same `/api/v1/ai/*` endpoints with no provider hardcoding.

## 10. Environment-blocked vs verified (honest status matrix)

| Provider | API verified | Key in `.env` | In `AI_PROVIDERS_ENABLED` | Effective status |
|---|---|---|---|---|
| OPENAI | ✅ | ✅ | ✅ | LIVE (health ok) |
| ANTHROPIC | ✅ | ✅ | ✅ | LIVE (health ok) |
| XAI/GROK | ✅ | ✅ | ✅ | CONFIGURED |
| GEMINI (`google`) | ✅ | ❌ no `GEMINI_API_KEY` | default list only | ENVIRONMENT_BLOCKED |
| GEMMA | ✅ (via Gemini) | ❌ | ❌ | ENVIRONMENT_BLOCKED |
| QWEN | ✅ (DashScope) | ❌ no `QWEN_API_KEY` | ❌ | ENVIRONMENT_BLOCKED |
| DEVIN | ✅ (real session API) | ✅ | ❌ (wired, not enabled) | VERIFIED / configured-but-not-enabled |
| Z_CODE_5_3 | ❌ UNVERIFIED | — | — | UNVERIFIED / disabled sentinel |

No provider endpoint, model ID, or capability was invented. Secrets remain server-side.
