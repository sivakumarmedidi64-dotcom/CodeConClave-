# CodeConClave — Failover Policy (Model Routing 2026)

Prompt 2 of 5 — Part 7. Documents the failover/fallback policy that the gateway enforces
and the router's role in it. This reuses the gateway's existing `completeWithFallback`
machinery — it is not a second execution path.

## 1. Where failover lives

`backend/src/modules/ai/gateway.ts` `completeWithFallback` is the single failover executor:
per-attempt timeout + caller cancellation + chain deadline + provider-health update +
`classifyProviderError` → `AiFallbackReason`. The router only *plans* the chain
(`fallbackChain` = top-3 capable candidates); execution and fallback are the gateway's.

## 2. Retryable vs non-retryable

| Outcome | Fallback? | Reason |
|---|---|---|
| timeout | YES | transient; advance chain |
| provider unavailable / network | YES | transient; advance chain |
| rate limited (per policy) | YES | advance chain, bounded; guidance surfaced never waited on |
| transient 5xx | YES | advance chain |
| invalid credentials / authz | NO | deterministic; surfaced |
| malformed request / API error | NO | deterministic; surfaced |
| safety refusal | NO | never silently retried |
| policy denial | NO | surfaced |
| caller cancellation | NO | never fall back after cancel |
| PROVIDER_NOT_CONFIGURED | skip | published separately (single provider remains) |

`provider_health` is updated on both success and failure so future eligibility is honest.

## 3. Bounded chain semantics

- Chain deadline (`AI_CHAIN_TIMEOUT_MS`) bounds the ENTIRE chain so a hanging provider can
  not hold output open indefinitely.
- A `usedFallback`/`fallbackReason` is always logged (`logUsage`) so the user and audit can
  see when and why the model changed.
- Failure is honest: when every attempt fails, `model_unavailable` is raised with the
  classified reason and retry guidance (rate-limit hint included when present).

## 4. Sensitive-task rule (no silent switching)

For AUTONOMOUS_ENGINEERING, TERMINAL_EXECUTION, and coworker/autonomous steps touching
external execution, deployments, destructive actions, protected workspace, sensitive
tools, or production: a fallback that changes the selected model must be surfaced/paused
through the existing permission/approval architecture (the router marks these task types
`sensitive`; the decision `requestedModelSubstituted` is explicit and auditable).

## 5. Router responsibilities in failover

- `fallbackChain` = the ranked capable remainder (top-3), so the gateway never fails over
  into a model that lacks a required capability.
- When the primary (or requested) model is unavailable, `requestedModelSubstituted: true`
  is set and the reason explains the substitution — no silent switching.
- The router never retries non-retryable errors; it relies on the gateway's classification.