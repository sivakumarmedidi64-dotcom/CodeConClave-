# PHASE 15 — Repository-Wide Security Audit & Hardening (Report)

## Status
COMPLETE. A full security audit of the codebase was performed and the genuine
findings were FIXED in code — not merely documented. High-impact verified
findings closed in this phase: (a) the core tool adapters trusted a
client-supplied `userId` in the tool input as the caller identity
(`execution/tools.ts`); they now derive identity ONLY from the server-set
execution context and fail closed without one. (b) the optional-auth
middleware silently demoted a valid session to anonymous on a session-lookup
failure (fail-open); it now fails closed with an honest 503
(`auth_unavailable`). (c) there was no session rotation on privilege changes;
MFA enable/disable now revokes every other ACTIVE session (all devices) and
issues a fresh session token, audited as `auth.session_rotated`. (d) the rate
limit store could fail open on auth paths; `authLimit` is now fail-closed
(503 `rate_limit_unavailable`) while non-security paths keep the documented
fail-open behavior. (e) no response correlation id existed; every response now
carries `X-Request-Id`. (f) watchdog error logging could serialize raw error
objects; it is now sanitized to message-only and counted per sweep via
`watchdog.<name>_failed` metrics. Genuine RLS gaps for tenant-scoped tables
created after 0015 (`memory_corrections`, `task_dependencies`, `task_dlq`,
`plans`, `plan_entries`) are closed by migration 0037 (static-only). The
observability layer now includes security-event metrics, an in-process error
buffer (message + traceId only), Sentry capture that is a guaranteed no-op
when unconfigured, a real health/readiness rollup (`/health`), and an
operator diagnostics API (`GET /api/v1/operations/diagnostics`, owner/admin).
The frontend surfaces the honest server health rollup in a HealthChip. Backend
848/848 (53 files), frontend 194/194 (34 files), all typechecks and both
production builds green. No existing tests were weakened.

## Security
- **Tool caller identity (HIGH, fixed)**: `registerCoreTools` adapters
  (`file_read`, `file_write`, `file_list`, `memory_search`) previously read
  `userId` from the tool `input` despite a header comment claiming it was
  server-set. Rewritten: `callerId(ctx)` uses `ctx.userId` only, ignores
  `input.userId`, and throws (fail CLOSED) when no authenticated context is
  present. The approved execution path (`approvals.ts`) already passed the
  server-set context; `executeToolCall` now passes it through as well (it was
  passing none, so the audit actor was hardcoded `system`).
- **Optional-auth fail-closed (HIGH, fixed)**: a DB failure during session
  lookup previously left the request anonymous (silent privilege
  downgrade). Now a 503 `auth_unavailable` — an honest degradation.
- **Session rotation (MEDIUM, fixed)**: enabling or disabling MFA revokes all
  ACTIVE sessions except the current one, creates a fresh session, and the
  route rotates the cookie. Old session tokens are dead immediately.
- **Rate-limit fail-closed (MEDIUM, fixed)**: `authLimit` returns 503
  `rate_limit_unavailable` when the limit store is down; `globalLimit` /
  `chatLimit` remain fail-open by design (non-security paths) — documented.
- **Headers**: added `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Resource-Policy: same-origin` to the existing header set
  (nosniff, DENY framing, no-referrer, Permissions-Policy, env-gated CSP,
  HSTS in prod).
- **Response correlation**: every response carries `X-Request-Id` = traceId
  (already logged per request).
- **Replay resistance**: a REVOKED/EXPIRED session row resolves to no user
  (tested); session tokens are random 32-byte opaque values whose SHA-256 hash
  is the only thing stored.
- **Error sanitization (already correct, now tested)**: the error handler
  already returned a generic body for unknown errors; the no-message/no-stack/
  no-secret guarantee is now regression-tested, and 5xx responses increment
  `http_5xx` and route to `captureError` with the traceId tag.

## Tenant isolation
- Migration 0015 documents intentional service-table exceptions
  (`ai_model_registry`, `provider_health`, `events`, `feature_flags`, plugins
  catalogue — read-only APIs only). The audit found five tenant-scoped tables
  created after 0015 WITHOUT RLS: `memory_corrections`, `task_dependencies`,
  `task_dlq`, `plans`, `plan_entries`.
- `database/migrations/0037_phase15_security.sql` (new): RLS + policies for
  all five. `USING` clauses are tenant-scoped through parent relationships
  (memories / tasks / plans → owner or project membership); writes are
  backend-service only (`WITH CHECK (false)`), matching the existing
  `model_usage_logs` pattern. Static-audited by tests (no live PostgreSQL —
  see Blockers).

## Prompt injection
- The full chain is deny-by-default and now regression-tested end-to-end:
  `parseToolRequest` (strict JSON, tool allowlist, object-input validation)
  → `evaluateToolCall` (immutable baseline: secrets/OS-sensitive paths,
  dangerous commands, scope/capability grants, then risk) → registered-tool
  registry. A spoofed payload cannot smuggle a `userId`, a secret path, or an
  unregistered tool past the chain; policy denial increments
  `security.*` metrics. Capability grants are created only through privileged
  auth-service policy, never by model output.

## Tool security
- Only the five registered adapters are executable; every adapter performs a
  real persisted operation or returns an honest failure. Execution without an
  authenticated context fails closed. Denied tool calls are audited
  (`EXECUTION_TOOL_DENIED`) with the real actor (user or system) and
  increment `security.tool_calls_denied`.

## Approval security
- Approvals remain the only path to HIGH-risk execution; no bypass was found.
  Failed approval execution now increments `security.approvals_failed`.
  (Existing approval-center tests unchanged and passing.)

## Payment security
- Evidence remains independently verifiable server-side only; client claims
  are rejected. Every rejection in `validateProviderEvidence` increments
  `security.payment_spoof_attempts` (tested).

## Secret security
- Secret-shaped paths (`.env`, `.ssh`, keys) and OS-sensitive paths are
  deny-by-default in policy with a dedicated `security.secrets_blocked`
  metric; path traversal is denied by the same immutable baseline.
- Health and diagnostics responses are scanned by tests for credential
  leakage (DSNs, API keys, Redis URLs, provider secrets) — none leak.
- Watchdog error logs carry message-only records; stacks and raw objects are
  never logged (tested with a stack carrying a planted secret).
- Recovery codes are stored hashed; MFA secrets encrypted at rest (existing
  guarantees re-verified in the updated auth tests).

## Audit
- `audit_logs` remains append-only (INSERT-only policies, no UPDATE/DELETE).
- New audited events: `auth.session_rotated` on every MFA privilege change;
  denied tool calls audited with the true actor. `security.auth_failures` and
  `security.suspicious_logins` metrics back the existing `AUTH_LOGIN_FAILED` /
  `AUTH_SUSPICIOUS_LOGIN` audit events.

## Observability
- `backend/src/observability/metrics.ts` (new): in-process counters +
  latency aggregates (`incMetric`, `recordLatencyMetric`, `metricSnapshot`,
  `resetMetrics` test hook). Security events: `security.auth_failures`,
  `security.suspicious_logins`, `security.tool_calls_denied`,
  `security.paths_blocked`, `security.secrets_blocked`,
  `security.commands_blocked`, `security.network_blocked`,
  `security.capability_denied`, `security.unknown_tool`,
  `security.approvals_failed`, `security.payment_spoof_attempts`,
  `security.plugin_scope_denied`, `http_5xx`, `watchdog.<name>_failed`.
- `backend/src/observability/error-buffer.ts` (new): 50-entry ring of
  `{ message, traceId }` (never stacks, never content) fed by
  `logger.error()`.
- `backend/src/shared/logger.ts`: `error()` buffers via a guarded lazy
  require — logging can never take the app down.

## Health checks
- `backend/src/health/health.ts` (new): `/health` (and diagnostics) return a
  real rollup: `api`, `database` (ping), `cache/Redis`, `queue`, `worker`
  (watchdog freshness, 90 s), `ai` (configured providers × persisted
  `provider_health`), `storage`, `local-agent` (hub presence + online
  count), `plugins`, `sentry`. Every check is HEALTHY / DEGRADED / FAILED /
  NOT_CONFIGURED. Rules: NOT_CONFIGURED is never labeled HEALTHY; overall =
  FAILED if any check fails, DEGRADED if any degrades or is not configured,
  HEALTHY only when everything is healthy. Backward-compatible fields
  (`ok`, `name`, `provider`, `queue`, `time`) are preserved.
- Frontend: `frontend/src/components/HealthChip.tsx` (new) polls `/health`
  every 60 s and shows Operational / Degraded / Down / Offline with a tooltip
  listing the problem checks; failures are silent (never a toast). Mounted in
  `Topbar`.

## Alerting
- No new alerting infrastructure is claimed. In-process alert surfaces are
  the watchdog failure metrics, the error buffer (visible via diagnostics),
  and `http_5xx`; Sentry captures real exceptions when configured. Operator
  alerting remains a deployment concern (see Remaining risks).

## Sentry
- `backend/src/observability/sentry.ts`: `captureError(err, { level, tags,
  extra })` is env-gated (`SENTRY_DSN` + `SENTRY_ENABLED=true`), never
  throws, never logs raw error objects, and is a no-op when the package is
  missing. Wired into the error handler with the traceId tag and into the
  health rollup (`sentry` check). Contract-tested only (no live DSN).

## Diagnostics
- `GET /api/v1/operations/diagnostics` (owner/admin only;
  `diagnostics_forbidden` otherwise): application version (resolved from
  `package.json` in both src and dist layouts), the full health rollup,
  queue depth (`task_dlq` count + `outbox_events` PENDING backlog), the
  metric snapshot, and recent buffered errors — no secrets, no user content.
- The authorization gate and content are tested.

## Failure handling
- All 11 failure categories tested in `failures-15.test.ts`: database down,
  cache/Redis down, AI providers down, plugins failing, storage not
  configured, worker watchdog stale, local agent offline, email (Resend)
  down, Sentry unavailable, queue not configured, outbox/queue-depth honest
  reporting. In every case the system reports honestly (FAILED/DEGRADED/
  NOT_CONFIGURED) instead of crashing or claiming health.

## Files created
- `backend/src/observability/metrics.ts` — counters + latency aggregates.
- `backend/src/observability/error-buffer.ts` — 50-entry sanitized error ring.
- `backend/src/health/health.ts` — real health rollup (10 checks, honest
  states, secret-free).
- `backend/src/modules/operations/diagnostics.ts` — operator diagnostics
  report (version, health, queue depth, metrics, recent errors).
- `database/migrations/0037_phase15_security.sql` — RLS for
  memory_corrections, task_dependencies, task_dlq, plans, plan_entries
  (static-only).
- `backend/src/foundation/security-15.test.ts` — 35 tests (tool identity,
  fail-closed auth, session rotation + replay, X-Request-Id, COOP/CORP,
  sanitized errors, rate-limit fail-closed, policy chain, security metrics,
  health rollup honesty, diagnostics content, RLS static audit, watchdog
  failure sanitization).
- `backend/src/foundation/failures-15.test.ts` — 15 tests (11 failure
  categories).
- `frontend/src/components/HealthChip.tsx` + `HealthChip.test.tsx` — server
  health indicator (5 tests).
- `docs/PHASE_15_REPORT.md` — this report.

## Files modified
- `backend/src/observability/sentry.ts` — `sentryModule()` +
  `captureError()` (no-op safe).
- `backend/src/shared/logger.ts` — `error()` buffers sanitized records.
- `backend/src/middleware/context.ts` — `X-Request-Id` response header.
- `backend/src/middleware/security.ts` — COOP/CORP headers; `http_5xx`
  metric; `captureError` on 5xx with traceId.
- `backend/src/middleware/rate-limit.ts` — `failClosed` option; auth limit
  from env + fail-closed; global/chat from env.
- `backend/src/middleware/auth.ts` — optionalAuth fail-closed (503
  `auth_unavailable`).
- `backend/src/modules/auth/service.ts` — `security.auth_failures` /
  `security.suspicious_logins` metrics; `rotateSessionsAfterPrivilegeChange`;
  `confirmMfa(userId, code, req)` → `{ recoveryCodes, sessionToken }`;
  `disableMfa(userId, code, req?)` → `{ sessionToken } | null`.
- `backend/src/modules/auth/routes.ts` — `/mfa/confirm` + `/mfa/disable`
  rotate the session cookie; imports consolidated.
- `backend/src/modules/execution/tools.ts` — REWRITE: ctx-only caller
  identity, fail-closed.
- `backend/src/modules/execution/toolcalls.ts` — ctx passthrough, real audit
  actor, `security.tool_calls_denied`.
- `backend/src/modules/execution/policy.ts` — `deny()` helper + six security
  metrics; traversal denied under the immutable baseline.
- `backend/src/modules/execution/approvals.ts` — `security.approvals_failed`.
- `backend/src/modules/payments/evidence.ts` —
  `security.payment_spoof_attempts` on every rejection.
- `backend/src/modules/plugins/engine.ts` — `security.plugin_scope_denied`.
- `backend/src/workers/watchdog.ts` — REWRITE: `errInfo` sanitization,
  per-sweep `watchdog.<name>_failed` metrics, `lastWatchdogRunAt()`;
  removed a `require.main` reference that would throw in ESM.
- `backend/src/modules/agent/ws.ts` — `stats()` + `hubAttached()`.
- `backend/src/app.ts` — `/health` returns `computeHealth()` + backward-compat
  fields; imports consolidated.
- `backend/src/modules/operations/routes.ts` — diagnostics route (owner/admin).
- `backend/src/modules/operations/diagnostics.ts` — version resolution
  fallback (src/dist).
- `backend/src/foundation/auth.test.ts` — MFA tests updated to the new
  confirmMfa/disableMfa signatures and rotation behavior.
- `frontend/src/lib/api.ts` — `Health` gains `status` + `checks`;
  `HealthCheck` / `HealthState` types.
- `frontend/src/components/Topbar.tsx` — mounts `HealthChip`.

## Database migrations
- `0037_phase15_security.sql` only (DDL + RLS; no table duplicates, no changes
  to existing policies). Static-only — see Blockers.

## Tests
- Backend: `npx vitest run` — 848/848 (53 files; new: security-15 35,
  failures-15 15). No existing test weakened.
- Frontend: `npx vitest run` — 194/194 (34 files; new: HealthChip 5).

## Typecheck / Build
- `shared`: built clean.
- `backend`: `npx tsc --noEmit` clean; `npm run build` clean.
- `frontend`: `npm run typecheck` clean; `npm run build` (vite) clean.

## Live infrastructure validation
- None beyond the existing runtime environment: PostgreSQL is not available
  here, so migration 0037 is unexercised against a live database; no
  `RESEND_API_KEY` (email stays PENDING by design); Razorpay API/webhook off
  (Payment Link mode only); no live AI credentials (health reports
  NOT_CONFIGURED — as tested); R2 not configured; Sentry live DSN absent
  (contract tests only).

## Remaining risks
- RLS policies for the five tables are validated statically (SQL review +
  test assertions), not against a live Postgres instance; a live migration
  run remains pending until a database is available.
- The overall health rollup labels a fully-configured-but-unexercised
  deployment as DEGRADED until every provider check has real health data —
  honest by design, but operators should treat NOT_CONFIGURED/DEGRADED
  states as configuration status, not outage.
- Operator alerting (paging on FAILED checks / watchdog metric thresholds)
  is not implemented; the observability surface now exists to build it on.

## Next phase
- Phase 16 must not be started without instruction. Candidate follow-ups when
  instructed: live E2E + migration 0037 execution once Postgres is available;
  Sentry enablement via env; operator alerting on the metrics/health surface.