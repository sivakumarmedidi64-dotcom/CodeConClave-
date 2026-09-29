# CodeConClave — Intelligent Model Routing (Model Routing 2026)

Prompt 2 of 5. The intelligence layer on top of the AI Provider Foundation (Prompt 1, gate
PASSED). ONE routing engine serves Web, Desktop, AI Chat, AI Coworkers, Autonomous Cowork,
Coding Workspace, Background Tasks, Memory-powered coding, and future multimodal workflows.

---

## 1. Architecture — one router, many surfaces

```
 request (web / desktop / chat / coworker / autonomous / memory-coded task)
        │
        ▼
 intent classifier            backend/src/modules/ai/intent.ts       (deterministic, no model round-trip)
        │   ClassifiedIntent { taskType, capabilityHints, candidates, reason }
        ▼
 TASK_POLICY                  backend/src/modules/ai/router.ts        (22 task types → policy)
        │   computeClass, requiredCaps, coding/reasoning, ctx, agent allow, sensitive
        ▼
 gateway.eligibleModels()     backend/src/modules/ai/gateway.ts       (health, config, entitlement, caps, privacy)
        │   SUPPORTED / CONFIGURED / AVAILABLE / HEALTHY / VERIFIED stay strictly separate
        ▼
 capability intersection      backend/src/modules/ai/capabilities.ts  (never drop a required cap)
        ▼
 preference ranking           rankByPreference (AUTO/QUALITY/BALANCED/FAST/COST_SAVER)
        │   user/workspace prefs (user_preferences.aiRouting) + preferred-model override
        ▼
 RoutingDecision              { taskType, selected, fallbackChain, reason, estimatedCost, … }
        │
        ▼
 gateway.completeWithFallback (execution + failover + usage audit incl. task_type/routing_preference)
```

The router is a **planning layer only** — it never executes. Execution, streaming, and the
failover chain remain in the gateway. There is exactly one orchestration system.

## 2. Capability matrix (never invented)

`ModelCapabilities` = text, reasoning, coding, vision, imageGeneration, imageEditing,
structuredOutput, streaming, toolCalling, autonomousAgent. Derived purely from registry
metadata (`support_*` columns, tier, compute class, coding_optimized, capability_category)
plus VERIFIED provider facts from Prompt 1. States stay separate:

| State | Meaning | Routed? |
|---|---|---|
| SUPPORTED | registry/verified capability flags | always true when eligible |
| CONFIGURED | server has an API key (`configuredProviders()`) | required |
| AVAILABLE | configured, not DOWN/DEGRADED, entitlement OK | required |
| HEALTHY | probe/registry health is HEALTHY | preferred |
| VERIFIED | endpoint identity verified (Prompt 1) | z_code_5_3 = UNVERIFIED |

## 3. RoutingPreference policy knobs

- **AUTO (recommended default)** — registry priority then cost, capability-aware.
- **QUALITY** — highest compute class first (best capability), then registry priority.
- **BALANCED** — registry priority then cost.
- **FAST** — lowest target latency among capable.
- **COST_SAVER** — lowest known cost among capable. **Never** skips a required capability
  for a lower price: capability filtering happens *before* ranking.

Preferences are policy knobs on the same engine, not separate systems. User preference is
stored in `user_preferences.aiRouting` (JSONB) and validated server-side.

## 4. Sensitive tasks — no silent switching

Task types marked `sensitive` (AUTONOMOUS_ENGINEERING, TERMINAL_EXECUTION and any coworker
or autonomous step over destructive/external surfaces) go through the existing
permission/approval architecture. A model change or fallback on these tasks pauses for
approval — the router never silently substitutes on a sensitive task without surfacing it.

## 5. Estimated cost — honest, never fabricated

`estimatedCost` is produced only when input length is known (`estimateInputTokens`). When
pricing is unknown or not derivable the field is `null` — we do not invent numbers. The
gateway's `estimateCost`/`estimatedCostOfRequest` remain the execution-time authority.

## 6. Observability

- `model_usage_logs.task_type` + `routing_preference` (migration 0070, nullable, additive,
  RLS untouched) catch every inference through the existing `logUsage` rail.
- Routing decisions are explainable: `reasonFor()` returns concise human reasons, never
  secrets, credentials, or scoring internals.

## 7. Uniformity

- **Web**: ModelPicker shows compact `AUTO` + explanation popover; explicit selection pins
  a model for the next turn only (bypasses no policy/limit).
- **Desktop**: thin `BackendClient.routingPreview()` calling the SAME `/api/v1/ai/routing`.
  No desktop-only brain, no provider secrets in Electron.
- **Coworkers**: each coworker type maps to a canonical task type and routes through the
  same planRoute → gateway path.
- **Autonomous work**: autonomous steps route with `AUTONOMOUS_ENGINEERING` intent and the
  gateway's external-agent opt-in gate.