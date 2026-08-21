# CodeConClave Pro — Security Guide (Phase 18)

Model: client-side state is **never** authoritative for identity, permissions,
plan, entitlements, payments, usage, task state, approvals, or model access.
Everything security-critical is enforced server-side and covered by automated
suites (`security.test.ts`, `security-15.test.ts`, `security-17.test.ts`,
`rbac.test.ts`, `auth.test.ts`, `approval-center.test.ts`, `payments-4d.test.ts`,
`plugins-10.test.ts`).

## Authentication & sessions

- Passwords: scrypt (N=2^14, r=8, p=1) via `backend/src/shared/crypto.ts`.
- Sessions: `cc_session` httpOnly cookie; `secure` driven by
  `SESSION_COOKIE_SECURE` (required `true` in production by the fail-fast
  guard). Access tokens have a short TTL; stale sessions are swept every 6h.
- MFA: TOTP + recovery codes; configurable requirement level; bounded attempts.
- Email verification required before privileged flows.

## Authorization & isolation

- RBAC roles enforced on every route group; diagnostics restricted to
  owner/admin.
- Tenant isolation: row-level security in `database/migrations/0015_rls.sql`
  scoping every tenant table to the workspace/user. RLS is active at runtime on
  all 106 tenant-scoped tables (verified live in Stage 25); a tenant-isolation
  smoke as a dedicated non-superuser app role remains a deploy-time check
  (pooler connects as `postgres`).
- Device pairing gates local execution / remote control; revoked sessions and
  unpaired devices are rejected (`local-execution-17.test.ts`).

## Web defenses

- CSRF: double-submit cookie + `X-CSRF-Token` on state-changing calls;
  webhooks and `/agent/` authenticated by signature/token instead.
- Headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, strict `Permissions-Policy`, COOP/CORP,
  CSP (`default-src 'self'`, `script-src 'self'`, `frame-ancestors 'none'`,
  …), and HSTS in production.
- Rate limits: global/auth/chat budgets, auth paths fail closed
  (`RATE_LIMIT_AUTH_PER_MIN`).
- CORS: explicit allow-list (`CORS_ORIGINS`), credentials + `Vary: Origin`.
- Error handling: sanitized 500 responses — never the raw message or stack;
  `traceId` correlation; Sentry capture is env-gated and can never throw.

## Execution safety

- No LLM output → direct execution: `INTENT → PLAN → POLICY → APPROVAL IF
  REQUIRED → EXECUTION → OBSERVATION → VERIFICATION → ARTIFACT → PERSISTENCE →
  MEMORY/DNA → AUDIT`. The policy engine is deterministic.
- Command-injection and prompt-injection guards are tested (`security.test.ts`).
- High-risk actions require approval; approvals are owner-scoped and cannot be
  bypassed; execution only on approval with server-held risk/action details.

## Payments & entitlements

- Payment Link only (current capability). A session stays `PENDING` until
  independent provider evidence (webhook signature verification or API status
  fetch). No client-side activation; entitlement only activates on `VERIFIED`
  (`backend/src/modules/payments/evidence.ts`). See
  `docs/PAYMENT_CAPABILITY.md`.

## Plugins

- Plugin connections carry scopes; scope escalation is rejected; failing
  connections are surfaced honestly (`plugins-10.test.ts`). Webhook delivery
  is restricted to `PLUGIN_WEBHOOK_ALLOWED_HOSTS`.

## OAuth

- Google sign-in state uses an HMAC-signed, expiring token with a
  protocol-bound prefix; tampering, key forgery, cross-protocol prefix
  swapping, signature swap, CSRF nonce replacement, and key rotation are all
  rejected (`security-17.test.ts`). Callback is fail-closed when Google is not
  configured.

## Production guard (Phase 18)

The backend refuses to start in production unless:
1. `SESSION_SECRET` and `JWT_SECRET` are strong random values (not the dev defaults).
2. `SESSION_COOKIE_SECURE=true`.
3. `CSP_ENABLED=true`.

Covered by `env-prod-guard.test.ts`.

## Operator diagnostics

`GET /api/v1/operations/diagnostics` (owner/admin only) exposes health,
queue depth (DLQ + outbox), metrics, and recent errors (message + traceId
only) — never secrets, connection strings, or user content.

## Open / residual items (documented, non-critical)

| Finding | Severity | Mitigation |
| --- | --- | --- |
| RLS + constraints not exercised against a live Postgres runtime | Medium (deployment-only) | Runbook checklist (`docs/RUNBOOK.md`) with exact SQL commands; static contract is in `database/`. |
| Session-expiry and digest sweeps depend on the long-running server process | Low | Both sweeps are idempotent and `unref()`'d; a single server keeps schedule. |
| Audit log has no automated retention/pruning | Low | Manual SQL documented in the runbook; automated job pending (known limitation). |
| Secrets guard requires operator discipline (does not rotate automatically) | Low | Rotation procedure in runbook. |