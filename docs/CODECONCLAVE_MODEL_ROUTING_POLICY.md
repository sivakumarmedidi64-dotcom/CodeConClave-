# CodeConClave — Model Routing Policy

Prompt 2 of 5 — Part 5/6. Defines how routing decisions are made per task type and how
cost/latency/quality preferences are applied without ever dropping a required capability.

## 1. Task-type policy table (22 canonical types)

| TaskType | computeClass | requiredCaps | coding | reasoning | sensitive | agents |
|---|---|---|---|---|---|---|
| GENERAL_CHAT | B | – | – | – | – | – |
| FAST_SIMPLE_QUERY | A | – | – | – | – | – |
| DEEP_REASONING | C | – | – | ✓ | – | – |
| SUMMARIZATION | A | – | – | – | – | – |
| MEMORY_RECALL | A | – | – | – | – | – |
| MEMORY_SYNTHESIS | B | – | – | ✓ | – | – |
| CODING | B | – | ✓ | – | – | – |
| CODE_REVIEW | C | – | ✓ | ✓ | – | – |
| DEBUGGING | B | – | ✓ | ✓ | – | – |
| TEST_GENERATION | B | – | ✓ | – | – | – |
| REFACTORING | B | – | ✓ | – | – | – |
| ARCHITECTURE | C | – | ✓ | ✓ | – | – |
| PLANNING / TASK_PLANNING | C | – | – | ✓ | – | – |
| DOCUMENTATION | B | – | – | – | – | – |
| MULTIMODAL_ANALYSIS | B | vision | – | – | – | – |
| IMAGE_GENERATION | B | imageGeneration | – | – | – | – |
| IMAGE_EDITING | B | imageEditing + vision | – | – | – | – |
| TOOL_USE | B | toolCalling | – | – | – | – |
| TERMINAL_EXECUTION | B | toolCalling | ✓ | – | ✓ | – |
| BACKGROUND_TASK | A | – | – | – | – | – |
| AUTONOMOUS_ENGINEERING | C | – | – | – | ✓ | allowed (opt-in) |

`COMMENT`: `reasoning`/`minContextTokens` are guidance (C-class bias + context floor);
`computeClass` stays the gateway's default; `eligibleModels` remains the only filter that
combines health/config/entitlement/capability/privacy.

## 2. Selection order (deterministic)

1. Intent classification (or explicit taskType from coworker/autonomous definitions).
2. `eligibleModels`: health (not DOWN/DEGRADED), entitlement (PRO vs free), configured
   provider, capability category (EXTERNAL_AGENT only if `allowExternalAgents`),
   privacy class, tools/vision/function-calling, context window, latency, compute class.
3. **Capability intersection** — `supportsRequiredCapabilities`; this is where required
   capabilities are enforced and where a cheaper model is **never** chosen over a capable one.
4. Explicit `requestedModelId` is honored when it passes capability+eligibility
   (`requestedModelHonored`), otherwise substituted honestly (`requestedModelSubstituted`).
5. Preference ranking (`rankByPreference`).
6. Decision + fallback chain (top-3 capable candidates).

## 3. Health-state handling

- DOWN/DEGRADED → excluded by `eligibleModels` (never picked, never silently swapped in).
- `healthState` on the decision surfaces the selected model's health at plan time.
- Environment-blocked providers (qwen/gemma/gemini have no keys; z_code_5_3 UNVERIFIED)
  are absent from `configured` and therefore cannot be routed. Honest `UNAVAILABLE`
  decision when nothing qualifies.

## 4. User preference interaction

- `routingPreference` (AUTO/QUALITY/BALANCED/FAST/COST_SAVER) + optional `preferredModelId`
  stored in `user_preferences.aiRouting`, validated by the server.
- Invalid/capability-violating preferences degrade to sensible defaults; they never force
  a model that lacks a required capability or is unhealthy/unconfigured.

## 5. Non-goals

- Routing is not a hidden override of a user's explicit choice for a *sensitive* step.
- Routing never exposes internal scoring, credentials, or provider secrets in reasons.