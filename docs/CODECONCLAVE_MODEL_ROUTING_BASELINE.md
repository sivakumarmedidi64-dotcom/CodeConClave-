# CodeConClave — Model Routing Baseline (Part 1)

Part 1 of Prompt 2/5 (Intelligent Model Routing + Failover + Capability-Aware Orchestration).
This document establishes the **as-is routing baseline**: what already exists and is
reusable, what Prompt 2 adds on top, and what must **never** be duplicated or invented.

Status: BASELINE CAPTURED (2026). Builds on the completed Provider Foundation (Prompt 1, gate PASSED).

---

## 1. What already exists (reuse these — do NOT duplicate)

### 1.1 Gateway — the execution spine (`backend/src/modules/ai/gateway.ts`)
The single post-routing execution path every AI feature funnels through. Prompt 2 adds an
*intelligence layer on top*; it does **not** create a second execution/orchestration system.

| Function | Purpose | Reused by router |
|---|---|---|
| `eligibleModels(userId, opts)` L89 | Filters registry by health (not DOWN/DEGRADED), entitlement (PRO vs free), `configuredProviders()` (server-side keys), capability category (external agents opt-in), privacy class, tools/vision/function-calling flags, context window, latency, compute class, tier. Returns models sorted by compute-class preference then priority then cost. | Yes — the router calls this for health/config/entitlement/capability filtering **before** preference ranking. |
| `routeModels(userId, opts)` L128 | Builds `{primary, fallback, tertiary}` honoring `AI_DEFAULT_MODEL` / `requestedModelId`, subject to eligibility. | Falls back to this for chat calls that predate explicit routing. |
| `completeWithFallback` L~410 | Executes the chain with per-attempt timeout + chain deadline + caller cancellation. **Failover policy already here**: retryable (timeout/provider-unavailable/network/rate-limit/transient 5xx) advances the chain; non-retryable (invalid credentials, authz, malformed, safety refusal, policy denial) never silently retries. | The router selects `{primary, fallbackChain}`; execution still runs through here. |
| `logUsage(ctx, summary, opts)` L322 | Inserts into `model_usage_logs` incl. `fallback_reason`. **Prompt 2 adds `task_type` + `routing_preference` columns** (migration 0070) and threads them via `RouteOptions`. | The audit rail for routing decisions. |
| `estimateCost` L520 / `estimatedCostOfRequest` L524 | Cost projection. | Router projects optional `estimatedCost` from `estimateInputTokens`. |
| `classifyProviderError` | Maps errors → `AiFallbackReason` (retryable vs not). | The failover gate (unchanged). |

### 1.2 Deterministic intent classification — precedent
- `backend/src/modules/conversations/intent.ts` `triageIntent` already distinguishes fast/deep
  without a model round-trip. This is the precedent for the new `intent.ts` classifier.
- New `backend/src/modules/ai/intent.ts` `classifyIntent` (Prompt 2): deterministic, no model
  call, maps request signals → 22-value `TaskType` taxonomy with honest capability hints.

### 1.3 Model eligibility assert / role routing
- `backend/src/modules/agents/service.ts` `assertModelEligible` (L179) + `ROLE_ROUTING`.
- `backend/src/modules/execution/coworkers.ts` `runCoworker` (L360) → `completeWithFallback`,
  `computeClass 'C'`, `coworkerType`.
- `backend/src/modules/conversations/chat.ts` `sendChatMessage` (L163) fast path:
  `computeClass 'B'`, `requestedModelId`, `privacyClass STANDARD`.

### 1.4 Web + desktop UX
- `frontend/src/components/ModelPicker.tsx`, `frontend/src/pages/ChatPage.tsx` — manual model pick.
- `desktop/src/cloud/client.ts` — **thin** shared-backend client (no provider secrets in Electron).
  Desktop must consume the **same** routing API (web/desktop uniformity), no desktop-only brain.

### 1.5 Provider state (from Prompt 1)
- `.env` keys present: OPENAI / ANTHROPIC / DEEPSEEK / GROK / KIMI / NVIDIA / DEVIN.
- `AI_PROVIDERS_ENABLED=anthropic,openai,grok,nemotron`; `AI_DEFAULT_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b`.
- No QWEN/GEMINI keys (qwen/gemma/gemini → `ENVIRONMENT_BLOCKED`); gemma shares `GEMINI_API_KEY` with google.
- `z_code_5_3` is an honest disabled `UNVERIFIED` sentinel.
- Rugged states kept separate: SUPPORTED vs CONFIGURED vs AVAILABLE vs HEALTHY vs VERIFIED.

---

## 2. What Prompt 2 adds (the intelligence layer)

| Module | Responsibility |
|---|---|
| `shared/src/constants.ts` | `TaskType` (22 values) + `RoutingPreference` (AUTO/QUALITY/BALANCED/FAST/COST_SAVER). Internal taxonomy, never cluttered UI. |
| `shared/src/domain/models.ts` | `ModelCapabilities` interface (10 capability leaves). |
| `backend/src/modules/ai/intent.ts` | Deterministic `classifyIntent` → `ClassifiedIntent` (taskType + capabilityHints + candidates + reason). |
| `backend/src/modules/ai/capabilities.ts` | `modelCapabilities` derivation, `supportsRequiredCapabilities`, `VERIFIED_PROVIDERS` / `UNVERIFIED_PROVIDERS`. |
| `backend/src/modules/ai/router.ts` | `TASK_POLICY` (all 22 task types → computeClass/requiredCaps/coding/reasoning/context/agents/sensitive), `planRoute` → `RoutingDecision`, `rankByPreference`, `reasonFor`. |
| `database/migrations/0070_model_routing.sql` | `model_usage_logs.task_type` + `routing_preference` columns (nullable, additive, RLS untouched). |
| `RouteOptions.taskType / routingPreference` | Threaded through `completeWithFallback` → `logUsage` for end-to-end audit. |

Routing decision shape (structured + explainable):

```ts
{
  taskType, selectedProvider, selectedModel, fallbackChain,
  reason, estimatedCost, capabilityMatch, confidence,
  healthState, routingPreference, requestedModelHonored, requestedModelSubstituted, features
}
```

Reason examples (concise, never leak secrets or scoring internals):
- `Selected Gemini because the request requires image/visual analysis.`
- `Selected <requested> because it is the requested model and satisfies all policy.`
- `Requested model unavailable; selected <name> as the best compliant fallback.`

---

## 3. Hard rules this design upholds

1. **ONE router**, no second AI engine, no architecture redesign.
2. **RoutingPreference = policy knobs**, never separate systems. `AUTO` is the recommended default.
3. **Never select a model lacking a required capability** just because it is cheaper
   (COST_SAVER only sorts within capability-satisfying candidates).
4. **No silent model switching for sensitive tasks** (external execution, deployments,
   destructive actions, protected workspace, sensitive tools, autonomous agents,
   production) — pause for approval via existing permission/approval architecture.
5. **TaskType is internal only** — never cluttered into UI; surfaced only via compact
   routing explanation (e.g. ModelPicker popover).
6. **No invented capabilities / model IDs / endpoints**; no fabricated real API calls;
   real routed call uses existing verified credentials (nemotron default).
7. States remain distinct: SUPPORTED / CONFIGURED / AVAILABLE / HEALTHY / VERIFIED.

---

## 4. What must NOT be duplicated

- A second `eligibleModels`/fallback chain. The router calls `gateway.eligibleModels` and
  relies on `gateway.completeWithFallback` for execution + failover.
- A second usage/audit writer. Routing metadata rides the existing `logUsage` rail.
- A second classification engine. `conversations/intent.ts` `triageIntent` (fast/deep) and
  `ai/intent.ts` `classifyIntent` (22-way taxonomy) coexist by contract: triage is a prior
  compute-class gate; the taxonomy is the canonical task type for routing + audit.

---

## 5. Test/verification contract (Prompt 2 gate)

32 routing areas (general chat, coding, debugging, code review, deep reasoning, multimodal,
image-gen filtering, autonomous engineering, unsupported capability rejection, unavailable
provider, environment-blocked, healthy selection, timeout failover, transient failover,
non-retryable, cost-saver/quality/fast/balanced, user preferred + invalid preferred,
workspace isolation, plan/entitlement, permission, audit metadata, web + desktop selection,
coworker routing, autonomous task routing, memory-aware ranking, secret redaction, payment
regression) + **at least one real request** through the new routing layer using existing
credentials (nemotron default).
