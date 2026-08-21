# PHASE 5 — AI Gateway + Model Routing + Compute Governance (Report)

## Status
COMPLETE. The centralized AI gateway with model registry, ordered routing
(entitlement → capabilities → context → privacy → health → latency → cost →
preference), honest fallback chains with recorded reasons, compute governance
(A/B/C classes + premium budget gate), streaming with per-attempt timeout and
caller cancellation, normalized typed tool-call requests through the
deterministic policy engine, chat integration, structured AI error handling,
and the Phase 5 test suite are implemented and validated. Nothing is claimed
as production-ready; see PostgreSQL runtime + External blockers.

## Files created
- `database/migrations/0027_phase5_ai_gateway.sql` — static-only migration (see Database migrations).
- `backend/src/foundation/ai-gateway-5.test.ts` — 36 Phase 5 tests.
- `frontend/src/components/ModelPicker.test.tsx` — 4 model selector tests.
- `docs/PHASE_5_REPORT.md` — this report.

## Files modified
- `backend/src/modules/ai/gateway.ts` — routing now enforces privacy class and latency requirements; `premiumAllowance` (entitlement check → compute policy → premium allowed? execute / denied → qualified cheaper → fallback / none → explain); per-attempt timeout + caller cancellation; fallback reasons recorded in usage logs; `getComputePolicy()`; `premiumBudgetRemaining(userId, cap)`; `requestToolCall` + `parseToolRequest` (typed tool-call normalization); class-A tier cap (EFFICIENT only).
- `backend/src/modules/ai/providers.ts` — `ProviderAdapter.supportsToolCalls` (openai/mistral true, anthropic/gemini false); `classifyProviderError` (rate_limited / invalid_credentials / timeout / unsupported_feature / stream_interrupted / provider_unavailable); `httpError` status mapping (401/403, 429, 408/504); shared SSE `sseReader` with honest stream_interrupted after partial emission; `updateProviderHealth` now maintains `consecutive_failures` (reset on healthy, increment on failure).
- `backend/src/modules/ai/routes.ts` — GET /models now returns the client shape with `id`/`label`/`tier`/`computeClass`/`health`/`locked`/`available` (fixes a pre-existing payload/type mismatch).
- `backend/src/modules/conversations/chat.ts` — chat opts now carry `privacyClass: 'STANDARD'`.
- `backend/src/config/env.ts` — `AI_REQUEST_TIMEOUT_MS` (default 120000).
- `shared/src/constants.ts` — `AiFallbackReason` taxonomy (`provider_unavailable`, `timeout`, `rate_limited`, `capability_mismatch`, `entitlement_mismatch`, `invalid_credentials`, `stream_interrupted`, `unsupported_feature`, `premium_compute_denied`).
- `frontend/src/components/ModelPicker.tsx` — single dropdown grouped by tier (PREMIUM/CAPABLE/EFFICIENT), provider-qualified labels, DOWN/locked options disabled, server default applied when the current selection is unusable.
- `frontend/src/lib/types.ts` — `AiModel` extended with `tier`, `computeClass`, `health`.

## AI Gateway
- `completeWithFallback` runs the full chain: compute governance gate → route → attempts over PRIMARY → FALLBACK → TERTIARY with per-attempt timeout (`AI_REQUEST_TIMEOUT_MS`, AbortController) and caller-signal cancellation (a user abort stops the chain — no fallback, `stream_interrupted`).
- Every inference writes a `model_usage_logs` row with tenant id, compute class, coworker type, token counts, cost, duration, `used_fallback` and the recorded `fallback_reason`; failures also log an honest row with the classified reason (`error_code` column exists for message error codes). Costs are computed from registry prices; token counts are chunk-reported or honest estimates — nothing is faked.

## Providers
- Four adapters (Anthropic, OpenAI, Google Gemini, Mistral) stream via the shared `sseReader`; each reports `supportsToolCalls` honestly (openai/mistral true; anthropic/gemini false until normalized tool-call support exists).
- Provider failures are classified into the shared taxonomy and drive `updateProviderHealth` (DOWN increments `consecutive_failures`, success resets it). Unconfigured providers (no API key) are skipped in routing via `configuredProviders()` — the gateway throws `no_model_available` with an honest message instead of inventing capability.

## Model registry
- Server-authoritative catalogue (0010 DDL + 0016 seed), filtered at load for `enabled` and non-deprecated models, overlaid with `provider_health` (UNKNOWN when no row). Routing never selects a DOWN or disabled model; PRO-entitlement models are unreachable for free plans; the client dropdown receives the authoritative server list.

## Routing
- Order enforced: 1) entitlement (PRO models excluded for free plans), 2) required capabilities (tools/vision/function-calling/context window), 3) context window, 4) privacy requirements (`STRICT` requests only reach STRICT models; STANDARD → STANDARD|STRICT), 5) provider/model health (DOWN excluded), 6) latency requirement (`maxLatencyMs`), 7) cost efficiency (priority then input/output price, class preference for A workloads), 8) user preference (`requestedModelId` honored when healthy and policy-eligible).
- Returns PRIMARY → FALLBACK → TERTIARY with honest collapse when fewer models exist.

## Fallback
- Fallback reasons are classified and recorded (`fallback_reason`): `provider_unavailable`, `timeout`, `rate_limited`, `capability_mismatch`, `entitlement_mismatch`, `invalid_credentials`, `stream_interrupted`, `unsupported_feature`, `premium_compute_denied`. When every attempt fails the gateway throws `model_unavailable` (or `unsupported_feature` for tool requests with no capable model) after updating provider health.

## Compute governance
- Classes: A = CHEAP (EFFICIENT tier only, cheapest qualified), B = STANDARD (normal coding), C = PREMIUM (budget-gated). `compute_policy` table is config-driven (max tier, premium budget, enabled) with environment defaults as fallback (`AI_PREMIUM_BUDGET_USD_PER_DAY` = $4/day).
- Pro policy: PREMIUM REQUEST → ENTITLEMENT CHECK → COMPUTE POLICY → premium allowed? execute; no → qualified cheaper model? fallback (reason recorded); no → structured `premium_compute_denied` error explaining the requirement. Default requests never silently spend premium compute: a class-B request that would land on a premium model is downgraded to a qualified cheaper path with `premium_compute_denied` recorded.
- Daily spend is per-user (`model_usage_logs` SUM vs cap); `/api/v1/ai/usage` reports `premiumBudgetRemainingUsd` for Pro.

## Streaming
- Chunks stream to the caller (`onChunk`) as they arrive; partial output is preserved; user cancellation aborts immediately (no fallback); per-attempt timeouts are classified `timeout` and continue down the chain.

## Tool calling
- MODEL OUTPUT → TOOL SCHEMA → DETERMINISTIC POLICY → APPROVAL IF REQUIRED → EXECUTION. `requestToolCall` routes to a model with function-calling support and produces a TYPED request via `parseToolRequest` (validates JSON shape, allowed tool, object input — `invalid_tool_request` otherwise). The typed request feeds the existing deterministic policy engine (`evaluateToolCall`): baseline deny-by-default (secrets, dangerous commands, blocked hosts), capability grants, risk class, approval requirement. No model output ever reaches execution directly.

## Chat integration
- `sendChatMessage` routes through the gateway (fast path) with `privacyClass: 'STANDARD'`, streams deltas to the SSE route, persists the assistant message with model/provider/token/latency metadata, records usage, audits the exchange, and marks FAILED with the structured error code when the gateway fails. Deep-work requests still branch to the task engine before any AI spend.

## Database migrations
- `0027_phase5_ai_gateway.sql` (static-only): `model_usage_logs` += `tenant_id`, `fallback_reason`, `coworker_type`, `error_code` + indexes (`idx_model_usage_tenant_created`, `idx_model_usage_task`); `compute_policy` table (class PK CHECK A/B/C, max_tier CHECK, premium budget, enabled) seeded A→EFFICIENT/0, B→CAPABLE/0, C→PREMIUM/4; RLS on `model_usage_logs` (owner read, backend write).
- PostgreSQL runtime is NOT available here: the migration is validated for structure only. It was never executed; no runtime migration success is claimed.

## Tests
- `backend/src/foundation/ai-gateway-5.test.ts` — 36 tests:
  - Registry (2): enabled/deprecation filter + health overlay; UNKNOWN health fallback.
  - Routing (7): privacy filtering, latency filtering, cheapest qualified, class-A tier cap, excludePremium, free-plan entitlement, distinct primary/fallback/tertiary.
  - Compute governance (8): premium with budget executes; budget exhausted → qualified cheaper fallback with `premium_compute_denied`; free entitlement mismatch → cheaper fallback (`entitlement_mismatch`); free without cheaper path → explain; class B never silently spends premium; explicit premium pick with budget executes; explicit pick exhausted → downgrade; `compute_policy` config honored; policy defaults; budget math.
  - Providers/fallback (4): success + usage metadata; primary failure → fallback with reason; rate-limit classification; all-attempts-fail honest error + failure usage row.
  - Streaming (3): partial deltas, user cancellation (no fallback), timeout → fallback chain.
  - Tools (5): parseToolRequest valid/invalid; router picks function-calling adapter; `unsupported_feature` when none; typed request through the deterministic policy engine (grant → allow, `.env` → baseline deny).
  - Chat (3): end-to-end routing/streaming/persistence/usage; gateway failure → FAILED message + audit + rethrow; free limit enforcement before any AI spend.
- `frontend/src/components/ModelPicker.test.tsx` — 4 tests (tier grouping + provider labels, locked/DOWN disabled, server default on unusable selection, empty placeholder).
- Existing `model-gateway.test.ts` (12) and all prior suites still pass.

## Total
553 (shared 46, local-agent 49, backend 396, frontend 62)

## Passed
553 / 553

## Failed
0

## Typecheck
PASS — all four workspaces (`npx tsc --noEmit`).

## Build
PASS — all four workspaces (`npm run build`).

## PostgreSQL runtime
NOT AVAILABLE — migrations 0021–0027 are static-validated only, never executed. No runtime migration success is claimed.

## External blockers
- No real provider API keys in this environment: adapters report `provider_not_configured`, routing skips unconfigured providers, and provider health stays UNKNOWN — the honest, documented behavior. Provider credentials must be configured at runtime.
- No lint scripts are configured in any workspace (root lint is a no-op), so no lint report is possible.
- Provider pricing/capabilities are configuration (registry + `compute_policy`), not hardcoded assumptions; no provider capability is invented.

## Next phase
Do not start automatically. Phase 6 (if requested) — deep memory/DNA retrieval integration points are already wired (memory block in `buildMessages`, episodic extraction after completion), ready for the memory phase.