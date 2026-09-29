# PKG-26 Scope & Audit — Universal Developer Integration Hub

**Package:** PKG-26 (CodeConClave PRO)
**Theme:** UNIVERSAL DEVELOPER INTEGRATION HUB — GITHUB + SLACK + ISSUE TRACKING + OBSERVABILITY + DEPLOYMENT + KNOWLEDGE
**Status:** SCOPE CONFIRMED — build phase

## 1. Canonical registry basis (no invented IDs)

PKG-26 consolidates the integration capabilities ALREADY TRACKED in the canonical registry and
matrices. There is **no dedicated "Integrations" group** in
`CODECONCLAVE_FINAL_MASTER_FEATURE_REGISTRY.md`; integration capabilities are scattered across
Group B ("External integrations", "Git Integration", "IDE Integration"), Group G (AI OS P3 — GitHub/
Slack/Jira connectors), and Group A verified features. PKG-26 does **not** create a new registry
group or invent IDs — it proposes an ADDITIVE "Universal Integration Hub" surface over the existing,
already-registered integration substrate.

The table below lists the EXACT canonical capabilities in PKG-26 scope (verbatim labels from the
registry / acceptance matrix / feature-preservation matrix and the existing adapter set), their
current state, the existing integration that already implements them, the PKG-26 gap, and the
required work. "Runtime status" is honest: live-provider status is ENVIRONMENT_BLOCKED unless real
credentials/connections are present (in this environment none are).

| Registry ID / Capability | Current State | Existing Integration | Gap | Required Work | Runtime Status |
|---|---|---|---|---|---|
| "External integrations" (Group B) | PARTIAL | `modules/plugins/*` (10 adapters, connections, OAuth, encrypted creds, health) | No unified read-only hub surface; no frontend panel | `modules/integration-hub` + IntegrationHubPanel | CONFIGURED (hub) / LIVE=ENVIRONMENT_BLOCKED |
| "Git Integration" (Group B) | PARTIAL | `adapters/github.ts` (repo/branch/commit/PR/issue/checks read; App JWT + token) | No write actions surfaced; no hub status | Hub capability matrix + security tests | ENVIRONMENT_BLOCKED (no live GitHub) |
| "IDE Integration" (Group B) | ROADMAP | `os/p3/ide.ts` (flagged) | Not an integration-hub provider | Mark UNAVAILABLE (out of hub scope) | NOT_REQUIRED |
| GitHub Integration (P3.6 / github.ts) | FLAGGED/PLANNED | `adapters/github.ts` + `webhooks.ts` GitHub HMAC ingestion | Hub status + webhook security proof | Hub + security tests | ENVIRONMENT_BLOCKED |
| Slack Integration (P3.5 / slack.ts) | FLAGGED/PLANNED | `adapters/slack.ts` (messages.send/channels.list) | Hub status + outbound-only honesty | Hub + capability matrix | ENVIRONMENT_BLOCKED |
| Jira Integration (P3.4 / jira.ts) | FLAGGED/PLANNED | no Jira adapter; registry notes connector | Report UNAVAILABLE (no Jira adapter/canonical anchor) | Mark UNAVAILABLE | UNAVAILABLE |
| Webhook Ingestion (HMAC) (F64, Group A) | PASS | `automations/webhooks.ts` (GitHub/Sentry HMAC + bearer; dedup via event_log UNIQUE) | No dedicated signature/security test file | `integration-hub.security.test.ts` (Phase 19 20-checks) | VERIFIED (logic) / LIVE=ENVIRONMENT_BLOCKED |
| Event Automation rules/triggers (F63) | PASS | `automations/executor.ts` (ingestEvent → rules → actions) | Event→workflow wiring proof test | Reuse executor in tests (no second engine) | VERIFIED (logic) |
| Plugin System connect/OAuth/sandbox (F77) | PASS | `modules/plugins/*` | Hub consolidates plugin status | Hub reads plugin tables (no second engine) | VERIFIED (logic) / LIVE=ENVIRONMENT_BLOCKED |
| Sentry (acceptance matrix) | PASS (cfg) / BLOCKED (no DSN) | `observability/sentry.ts` + `adapters/sentry.ts` | Hub observability linkage + webhook HMAC test | Hub reads observability presence | ENVIRONMENT_BLOCKED |
| Deployment providers (PKG-21) | PASS (cfg) / BLOCKED | `release/provider.ts` (providerCapability honest states) | Hub consolidates deployment provider capability matrix | Hub reads `listProviderCapabilities()` | ENVIRONMENT_BLOCKED |
| GitHub App (acceptance matrix) | PASS (cfg+tooling) / BLOCKED | `adapters/github.ts` App JWT + `env.GITHUB_*` | Hub reports honest status | Hub | ENVIRONMENT_BLOCKED |
| Linear adapter (file, undocumented) | adapter exists | `adapters/linear.ts` | Hub surfaces as issue-tracking provider | Hub capability matrix | ENVIRONMENT_BLOCKED (no creds) |
| Discord adapter (file, undocumented) | adapter exists | `adapters/discord.ts` | Hub surfaces (communication) | Hub | ENVIRONMENT_BLOCKED |
| Vercel/Cloudflare adapters | adapter exists | `adapters/vercel.ts`, `adapters/cloudflare.ts` + release provider | Hub surfaces (deployment) | Hub | ENVIRONMENT_BLOCKED |
| Notion / Figma / Datadog / Render / Confluence | **zero canonical presence** | no adapter | Out of honest scope | Mark UNAVAILABLE / NOT_REQUIRED | UNAVAILABLE / NOT_REQUIRED |

## 2. Integration strategy (Phase 2 — ranking)

Ranked by IMPACT + FEASIBILITY + USER_VALUE + SECURITY_RISK + MAINTENANCE_COST, reusing the existing
substrate (no provider added just because it appears in a roadmap):

- **TIER 1 (surfaced in-hub, reuse-existing):** GitHub, Slack, Linear, Sentry, Deployment providers
  (release abstraction), generic Webhook. All already have adapters / webhook ingestion; PKG-26
  surfaces them honestly in the hub and hardens their security.
- **TIER 2 (existing adapter, surfaced in-hub):** GitHub Actions (webhook), Notion and Figma have
  **no adapter/canonical anchor → UNAVAILABLE** (not implemented). Datadog → NOT_REQUIRED.
- **TIER 3 (existing adapter, surfaced in-hub):** Discord (communication), Cloudflare + Vercel
  (deployment). Railway/Render extensions → UNAVAILABLE (no adapter, no canonical anchor).

**Do-not-implement decision (honest):** Notion, Figma, Datadog, Render, Confluence, Jira have **no
canonical registry presence and/or no adapter**. Per the master prompt ("Do NOT implement a provider
simply because its name appears in a roadmap"), these are reported `UNAVAILABLE` / `NOT_REQUIRED`,
not fabricated.

## 3. What PKG-26 actually builds (reuse-driven, no second engine)

1. **`backend/src/modules/integration-hub/`** — a READ-ONLY Universal Integration Hub service + routes
   that consolidates the existing surfaces (`/api/v1/plugins`, `/api/v1/release`, `/api/v1/webhooks`,
   `/api/v1/observability`) into one coherent catalog:
   - Provider state mapped from existing plugin connection state + adapter presence + server config,
     using the master-prompt vocabulary (AVAILABLE / CONNECTED / AUTH_REQUIRED / CONFIGURED /
     UNCONFIGURED / DISCONNECTED / EXPIRED / ERROR / UNSUPPORTED / ENVIRONMENT_BLOCKED).
   - Provider capability matrix (from plugin adapter `capabilities`/`actions` + release
     `listProviderCapabilities()`).
   - Webhook sources + deployment provider + observability summaries.
   - **Never** exposes tokens/secrets (only connection state/scopes/last_event/health).
2. **`backend/src/modules/integration-hub/integration-hub.security.test.ts`** — genuinely NEW tests
   (no plugin/webhook test file exists) covering Phase 19's 20 security checks at the engine level,
   reusing existing crypto + `ingestEvent` + plugin isolation helpers.
3. **Event→workflow wiring proof** (reuse `automations/executor.ingestEvent` — no second engine).
4. **`frontend/src/components/IntegrationHubPanel.tsx`** + test — genuinely NEW (no plugin/integration
   UI exists).

## 4. Honest live-provider position

- No real provider credentials / connections exist in this environment.
- `LIVE_PROVIDER_TEST = ENVIRONMENT_BLOCKED` for every provider.
- `GITHUB / SLACK / ISSUE_TRACKING / OBSERVABILITY_INTEGRATION / DEPLOYMENT_PROVIDER_INTEGRATION /
  KNOWLEDGE_INTEGRATION / DESIGN_INTEGRATION` = **ENVIRONMENT_BLOCKED or UNAVAILABLE/NOT_REQUIRED** —
  never forged VERIFIED.

## 5. Hard rules honored

NO FEATURE DELETION · NO TEST WEAKENING · NO FAKE INTEGRATIONS · NO FABRICATED CONNECTIONS · NO FAKE
WEBHOOKS · NO STALE 256-FEATURE BASIS · NO PAYMENT REWORK · NO SECOND AUTOMATION/ORCHESTRATION ENGINE
· DO NOT START THE 5/5 PHASE.
