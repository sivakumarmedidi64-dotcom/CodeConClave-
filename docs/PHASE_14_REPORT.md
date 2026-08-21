# PHASE 14 — Production Notifications, Billing UX, Live Integration Hardening (Report)

## Status
COMPLETE. Email delivery is now production-grade through the outbox: events
carry an idempotency `dedupe_key` (a topic+key enqueues once), recipients are
resolved from the persisted `users.email` (never client-supplied), provider
errors are classified (permanent `auth_invalid`/`invalid_request` fail fast,
`rate_limited`/`provider_unavailable`/`provider_unreachable` retry with
exponential backoff `2^attempts` minutes capped at 60), every failure records
`last_error`, and final failure of sensitive notification events (auth/
payment/security topics) is audited as `email.delivery_failed`. When the
email provider is not configured, events stay PENDING and retry — delivery is
never faked. Quiet hours are now timezone-aware (IANA via Intl, UTC fallback).
Server-side daily/weekly digests are built on REAL persisted evidence (tasks
completed/failed/recovered, pending approvals, project + team activity,
coworker research, memory/DNA updates, unread notifications, usage) with a
deterministic summary by default; the AI narrative path is strictly
evidence-only and only activates when a provider is actually configured; the
UNIQUE (owner, frequency, period_key) constraint guarantees a period is never
delivered twice, DND/quiet hours suppress the EMAIL channel only (the digest
is still persisted with an in-app notification), and a watchdog sweep covers
all users with digest preferences. Browser notifications have an honest
capability foundation: only while the app is open, only with granted
permission, no push infrastructure claimed. The unified provider status view
reports AVAILABLE/LIMITED/NOT_CONFIGURED/REQUIRES_REAUTH/DEGRADED/FAILED per
provider derived server-side from the real configuration, with capabilities
and sanitized reasons — secrets are never exposed. Billing UX is
server-authoritative: pricing renders from `capability.plans`, usage shows
MEASURED/ESTIMATED/CONFIGURED LIMIT from `/workspace/usage/overview`, PENDING
shows the exact waiting-for-independent-verification copy, cancellation is an
explicit approval-gated request (`plan.cancellation_requested` + PAYMENT_OP
HIGH proposal; approving never bypasses payment verification), and the
entitlements endpoint now emits the frontend-facing JSON contract.
Backend 796/796 (51 files, +44), frontend 189/189 (33 files, +23), shared
rebuilt, all typechecks and both production builds green. Migration 0036 is
static-only — see Blockers.

## Files created
- `database/migrations/0036_phase14_ops.sql` — `ALTER outbox_events` (+
  `last_error text`, + `dedupe_key text`) with unique partial index
  `idx_outbox_dedupe_key` on non-null dedupe keys; `digest_deliveries`
  (id `dig_`, owner_id FK users, frequency CHECK daily|weekly, period_key,
  period_start/end, evidence jsonb, summary_text, ai_generated, delivered_at,
  created_at, UNIQUE (owner_id, frequency, period_key)) with RLS. (Does NOT
  recreate `idx_outbox_status_next`, which already exists from migration
  0014.)
- `backend/src/modules/digests/service.ts` + `routes.ts` — timezone helpers
  (`localDateKey`/`isoWeekKey` via Intl, UTC fallback for invalid timezones),
  `digestPlanFor` (weekly > daily > none, timezone from prefs then quiet
  hours, DND = dnd flag OR timezone-aware quiet hours), `periodKeyFor`,
  `collectEvidence` (real queries against tasks/approvals/project_activity/
  team_activity/coworker_runs/memories/dna/notifications/model_usage_logs/
  usage_events), `deterministicDigestText`, `summarizeDigest` (evidence-only
  AI via `completeWithFallback`, deterministic fallback, never invents),
  `deliverDigest` (pre-check + ON CONFLICT idempotency, email suppression
  under DND/quiet hours, in-app digest.daily/weekly notification, outbox
  dedupe key `digest:<userId>:<frequency>:<periodKey>`, `digest.delivered`
  audit), `sweepDigests` (bounded, per-user failure never stops the sweep),
  `toDigestJson`, `latestDigest`; routes `GET /api/v1/digests/status` and
  `/api/v1/digests/latest`.
- `backend/src/modules/operations/service.ts` + `routes.ts` — `providerStatus`
  for razorpay (link always on; api/webhook from credentials; LIMITED until
  both, AVAILABLE only with API + webhook secrets), resend (env key +
  RESEND_ENABLED), google/github (plugin health states: CONNECTED →
  AVAILABLE, DEGRADED → DEGRADED, FAILED/ERROR → FAILED, REAUTH_REQUIRED →
  REQUIRES_REAUTH with sanitized reason + last known state, DISCONNECTED →
  NOT_CONFIGURED), sentry (DSN + enabled), storage (memory LIMITED, s3/r2
  from credentials), AI providers (enabled ∩ configured keys, health from
  `provider_health`); `sanitizeProviderError` redacts credential-shaped
  values (`key=`, `client_secret=`, `access_token=`); route `GET
  /api/v1/operations/providers`.
- `frontend/src/lib/browserNotifications.ts` + `browserNotifications.test.ts`
  — honest capability detection (`supported`/`permission`/`reason`),
  permission request, `showBrowserNotification` (only fires with granted
  permission and the Notification API; returns false otherwise; browser-
  managed delivery even from a hidden tab; click activation wiring),
  `labelFor` type→title mapping; 10 tests.
- Frontend tests: `TopbarPhase14.test.tsx` (5 — badges + relative timestamps,
  per-item dismiss via DELETE, click → navigate + mark-read, browser
  notification for NEW items after the seed poll with fake timers, no
  notification without granted permission), `SettingsPagePhase14.test.tsx`
  (8 — server-driven price from `capability.plans`, cancellation request
  flow, usage table MEASURED/ESTIMATED/CONFIGURED LIMIT, timezone persisted,
  honest unsupported/granted browser-notification states, provider statuses
  with capability chips + reauth CTA, no secret rendering).
- `docs/PHASE_14_REPORT.md` — this report.

## Files modified
- `shared/src/constants.ts` — `NotificationPreferenceKey.TIMEZONE`,
  `NotificationType.DIGEST_DAILY/DIGEST_WEEKLY`, `AuditAction.EMAIL_DELIVERY_FAILED/DIGEST_DELIVERED/PLAN_CANCELLATION_REQUESTED`,
  `ProviderStatus` enum (+ type).
- `shared/src/contracts.ts` — `timezone` in `notificationPreferencesSchema`;
  `providerCapabilitySchema`/`providerStatusEntrySchema`/`providerStatusResponseSchema`;
  `digestDeliverySchema`/`digestStatusSchema` (+ types).
- `backend/src/modules/outbox/deliver.ts` — `EmailErrorClass`,
  `classifyResendStatus` (401/403 auth_invalid, 400/422 invalid_request,
  429 rate_limited, 5xx provider_unavailable), `EmailDeliveryError`,
  `Idempotency-Key` header from the dedupe key (or event id), network
  failures → provider_unreachable.
- `backend/src/modules/outbox/service.ts` — idempotent `enqueueOutbox`
  (pre-check + `ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO
  NOTHING`, returns whether inserted), `resolveRecipient` (payload.userId →
  users.email, else payload.to), exponential backoff
  `now() + (least(power(2, attempts), 60) || ' minutes')::interval`,
  permanent classes fail immediately with `last_error` + `next_attempt_at
  + 1 day`, sensitive-topic final failures audited (`email.delivery_failed`),
  `RESEND_ENABLED === 'true'` gate (otherwise PENDING, `not_configured`).
- `backend/src/modules/notifications/service.ts` — `timezone` on
  `NotificationPreferences`; exported `localMinutes` + `inQuietHours`
  (timezone-aware, UTC fallback); `notifyUser` outbox payload carries
  top-level `userId` (existing `to: userId` contract preserved).
- `backend/src/modules/payments/service.ts` — `requestPlanCancellation`
  (PENDING|VERIFIED sessions only; `session_not_cancellable` otherwise;
  `proposeApproval` PAYMENT_OP HIGH with affected resource + proposed
  action; `payment_audit` `admin.cancel_requested`; `plan.cancellation_requested`
  audit); `toEntitlementJson` (id/planId/state/activatedAt/expiresAt/reason/
  sessionId).
- `backend/src/modules/payments/routes.ts` — `GET /entitlements` emits the
  JSON contract via `toEntitlementJson`; `POST /sessions/:id/cancel-request`.
- `backend/src/shared/ids.ts` — `PREFIX.DIGEST = 'dig'`.
- `backend/src/app.ts` — mounts `/api/v1/digests`, `/api/v1/operations`.
- `backend/src/server.ts` — digest sweep every 5 minutes (unref).
- `frontend/src/lib/types.ts` — Phase 14 types (`ProviderStatusEntry`/
  `ProviderCapability`/`ProviderStatusReport`, `DigestDelivery`/
  `DigestStatus`, `BrowserNotificationPermission`-adjacent shapes,
  `timezone` on `NotificationPreferences`, `Entitlement` gains
  `expiresAt`/`reason`/`sessionId`).
- `frontend/src/components/Topbar.tsx` — notification center: type badges
  (`labelFor`), relative timestamps, per-item dismiss (DELETE), click →
  navigate by resourceType + per-item mark-read, browser notifications for
  NEW unread items via the 30s poll (seed poll only primes the dedupe set;
  no duplicates).
- `frontend/src/pages/SettingsPage.tsx` — new `providers` tab (server-derived
  statuses, capability chips, reauth CTA, refresh, "secrets never shown");
  billing revamp (price from `capability.plans`, refresh, cancellation
  request per PENDING/VERIFIED session, usage table with MEASURED/ESTIMATED/
  CONFIGURED LIMIT + reset date, entitlements show reason/expiry); notifications
  tab (timezone field persisted, honest browser-notification capability UI,
  digest status incl. last delivery + AI flag).

## Backend tests added (`backend/src/foundation/`)
- `outbox-14.test.ts` (12) — idempotent enqueue (pre-check + ON CONFLICT,
  duplicate returns false, no dedupe key → null), recipient resolution to
  persisted email, Idempotency-Key from dedupe key, non-email events skip the
  provider, status classification, transient → PENDING with exponential
  backoff SQL, permanent → immediate FAILED, max-attempts → FAILED,
  not-configured stays PENDING (`not_configured`), sensitive-topic final
  failure audited, non-sensitive topics not audited.
- `digest-14.test.ts` (12) — timezone date/week keys incl. invalid tz fallback,
  plan selection (weekly > daily, timezone precedence), timezone-aware quiet
  hours DND in/out, deterministic text contents, full delivery (evidence SQL
  contract against all ten real tables, in-app notification, outbox dedupe
  key, audit), period idempotency, DND suppresses email only, AI narrative
  only with a configured provider (ai_generated true + provider called),
  sweep delivers daily + weekly and skips preference-less users.
- `operations-14.test.ts` (9) — Razorpay LIMITED (link ON, api/webhook OFF) vs
  AVAILABLE (all three), Resend NOT_CONFIGURED vs AVAILABLE, Sentry/storage
  honest states, plugin state mapping (CONNECTED/REAUTH_REQUIRED with
  sanitized reason/FAILED/DISCONNECTED/none), AI provider filtering by
  configured keys + health, full-report secret scan, `sanitizeProviderError`.
- `billing-14.test.ts` (11) — capability catalog (payment-link-only vs full,
  plans {pro:999, team:4999}), entitlement JSON contract, all states exposed,
  `effectivePlan` server-authoritative gate (PRO_PENDING/REVOKED → free,
  PRO_VERIFIED → pro), limits mapping, cancellation request (approval
  proposal args, payment_audit, audit), rejects expired and other-user
  sessions.

## Validation
- `shared`: `npm run build` clean (dist consumed by backend).
- `backend`: `npx vitest run` — 796/796 (51 files; Phase 14 files 44);
  `npm run typecheck` clean.
- `frontend`: `npm run typecheck` clean; `npm run build` (vite) clean;
  `npx vitest run` — 189/189 (33 files; Phase 14 files 23).
- Honesty rules enforced: delivery is never faked when Resend is not
  configured (PENDING + `not_configured`, tested); permanent provider errors
  fail fast, transient retry with exponential backoff (tested against the
  real backoff SQL); digests use only persisted evidence and the AI narrative
  is gated on `configuredProviders()` (tested both paths); a digest period is
  never delivered twice (UNIQUE + pre-check, tested); DND/quiet hours
  suppress email only (tested); provider status is derived server-side from
  the real configuration and secrets never reach responses (tested with a
  full-report scan); billing stays server-authoritative (`effectivePlan`
  grants Pro only from PRO_VERIFIED, tested) and PENDING shows the exact
  verification copy; browser notifications never claim push/offline delivery.

## External blockers
- PostgreSQL runtime still unavailable: migration 0036 is static-only (DDL +
  RLS) and unexercised against a live database; the digest sweep and outbox
  retries have not run against real Postgres.
- No `RESEND_API_KEY` in the runtime environment: real email delivery is
  covered by contract tests with a mocked provider; in production events
  stay PENDING until configured (as designed).
- Razorpay API + webhook unavailable here (Payment Link mode only): PENDING
  sessions remain PENDING; API/webhook evidence paths are contract-tested.
- No live AI provider credentials: digest AI narrative is contract-tested;
  production uses the deterministic summary until a provider is configured.
- A live browser smoke run against real Postgres remains pending until the
  database is available.

## Next phase
- Phase 15 must not be started without instruction. Candidate follow-ups when
  instructed: live E2E once Postgres is available, push-notification
  infrastructure (service worker + Web Push) when desired — the honest
  capability UI already reports the current limitation — and per-digest
  settings (e.g., digest time-of-day).