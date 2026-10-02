# CodeConClave Pro — External Agent Architecture (Prompt 4)

## Summary

External agents (Devin, Manus) are represented as a **canonical external-agent
abstraction** inside the existing AI gateway — not as a second AI engine and not
as chat-completion clients. They are out-of-band **job lifecycles** whose state
is provider-reported and whose UI is honest about what was and was not executed.

## Canonical class

- Registry: `ai_model_registry.capability_category = 'EXTERNAL_AGENT'`
  (`devin-session`, `manus-1.6`), derived per model by `capabilityClassOf`
  (`backend/src/modules/ai/capabilities.ts`) → `EXTERNAL_AGENT`.
- `/models` returns `capabilityClass` for every model; the model picker renders
  an `agent` chip and the composer never presents an external agent as a
  chat model.
- Routing/eligibility: an EXTERNAL_AGENT participates ONLY under the
  `allowExternalAgents: true` option and explicit user intent — never in a
  normal text/chat chain.

## Adapter contract (`providers.ts`)

Both adapters implement the standard `ChatStreamAdapter` surface:

| Step | Devin | Manus |
| --- | --- | --- |
| Lifecycle | `POST /v1/sessions` (create) → poll status → terminal | `POST /v1/tasks` (create) → poll → terminal |
| Start event | `externalRun: { externalId: sessionId, status: 'running', startedAt }` | same with task id |
| Terminal event | `externalRun: { externalId, status: 'finished', startedAt }` | same |
| Text | session prompt-results text | task completion text |

The `externalRun` payload rides the normal `ChatChunk` so the gateway, SSE stream
and chat page all observe the same fact stream. The gateway copies the last
`externalRun` into `CompletionSummary` and still counts tokens/cost where known.

## Honesty guard (never silent substitution)

`chat.ts` pins a known external agent to explicit routing:

- The agent must be present in the enabled registry (`getModel`).
- Its provider must be configured (`configuredProviders()`).
- It is routed with `allowExternalAgents: true`,
  `taskType: AUTONOMOUS_ENGINEERING`, capability `EXTERNAL_AGENT`.
- A pinned-but-unavailable agent is an **error**
  (`agent_not_configured`), never a silent switch to a normal model.

## Audit + usage

Every external-agent run is audited (`ai.external_agent_run`) with the
provider-reported run id, agent, provider, status, and task type. `model_usage_logs`
gains `capability` and `external_run_id` (0073). Deletion/secret policy
unchanged — no key material is stored or logged.

## Honest run status (this gate)

| Agent | Adapter | Real session created in this gate? | State |
| --- | --- | --- | --- |
| Devin | session-lifecycle wrapper | NO (key-gated; no task-creating call permitted) | adapter unit-tested; real run UNVERIFIED |
| Manus | task-lifecycle wrapper | NO (no safe read-only probe) | adapter unit-tested; ENVIRONMENT_BLOCKED |

The UI renders provider-reported facts via the `external_agent` SSE event
(external id + status). It never implies execution beyond what the provider
reported.