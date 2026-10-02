# FIRST CUSTOMER LAUNCH CHECKLIST — CodeConClave

Prepared for live launch. Read-only/operational checklist; no source changes, no deploys.
Live URLs:
- Website (frontend): `https://frontend-production-e367.up.railway.app`
- Backend: `https://backend-production-95faa.up.railway.app`

## 1. Website
- [x] `GET /` returns 200 (SPA redirects to `/login`).
- [x] `/login`, `/register`, `/pricing`, `/agents`, `/projects`, `/settings` return 200 (SPA fallback).
- [x] Frontend security headers present (CSP, HSTS, nosniff, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy).
- [x] Bundle secret scan clean; no backend URL literal in JS.

## 2. Authentication
- [x] Signup → 201 (CSRF required).
- [x] Login → 200 (Secure cookies `cc_session` + `codeconclave_csrf`).
- [x] `/auth/me` on session → 200.
- [x] Logout → 200 then `/auth/me` → 401 (session invalidated).
- [x] CSRF enforced (mismatch → 403); malformed body → 400; bad creds → 401.
- [x] Tenant isolation (foreign resources → 404).

## 3. Google login
- [x] Authorize 302 → `accounts.google.com` (redirect_uri = backend callback, offline access, state).
- [x] Callback without code/state → 400 `google_callback_invalid`.
- [ ] Full interactive consent round-trip: manual test with a real Google account (not automated; needs human sign-in).

## 4. AI
- [x] Chat through FE proxy → 200 `text/event-stream` (`thinking_start` → `delta` → `done`), message persisted.
- [x] Google `gemini-3.7-flash` working end-to-end; `ai.completed` in logs.
- [ ] NOTE: Anthropic + OpenAI providers show billing/quota failures (non-blocker; Google is the working provider). Watch for further degradation.

## 5. Projects
- [x] Create project via FE → 201 (owner-scoped); list/archive work.
- [x] Conversation create + message persistence verified.

## 6. Memory
- [x] AI-inferred memory stored + listed for a project.
- [ ] NOTE: semantic embedding search may intermittently return 429 (rate limit) — memory storage works; search enrichment is degraded until the embedding provider is backed by sufficient quota.

## 7. Execution
- [x] Cloud task create → 201; status RUNNING with live worker heartbeat.
- [ ] Terminal SUCCESS/FAILED of a task: observe to completion (up to ~15 min). Worker/watchdog confirmed healthy via `/health` and startup log (`task worker started pollMs=2000`).

## 8. Support / contact path
- [x] Frontend provides in-app account/entitlement status (truthful PRO_PENDING language).
- [ ] Provision a human support contact (email/form) for payment/account questions before paid launch. No production support channel currently configured (Sentry NOT_CONFIGURED; no hosted support inbox wired).

## 9. Pricing
- [x] `Upgrade to PRO (₹999)`; team ₹4999 displayed.
- [x] Capability shows `payment-link mode` (Razorpay not configured on server).
- [x] Sessions stay `PENDING` until provider confirmation (server-authoritative).
- [x] NO false "automatic activation guaranteed" claim present.

## 10. Payment status
- [x] Zero-admin payment = **BLOCKED** (no Razorpay API/webhook/admin; no automatic safe user correlation).
- [ ] Do NOT present payment activation as zero-admin / instant until a trusted provider verification path is live.
- [ ] Do NOT recommend that customers pay through the current static payment link if it would leave them in REVIEW/manual verification.

## 11. Known limitations
- Anthropic + OpenAI provider billing/quota issue (Google functioning).
- Memory embedding search may 429 intermittently.
- Object storage NOT_CONFIGURED (in-memory dev store for storage subsystem).
- Local Agent hub DEGRADED (no local agent online); plugins + Sentry NOT_CONFIGURED.
- Google OAuth full interactive consent not automated.
- Payment automation not available yet.

## 12. Privacy / security
- [x] CSP/HSTS/nosniff/XFO/Referrer/Permissions headers live.
- [x] Error responses are clean JSON (no stack traces, no secrets).
- [x] No production secret values in bundle/bundle-clean scan.
- [x] Session invalidation + tenant isolation + CSRF verified.
- [x] `frame-ancestors 'none'`, permissions-policy restrictive (camera/mic/geolocation off).

## 13. Monitoring
- [x] `/healthz` process-liveness; `/health` component checks (core api/db/cache/queue/worker/AI HEALTHY).
- [x] Railway logs reviewed: 0 FATAL, 0 crash, 0 DB/Redis failures; known AI provider warnings only.
- [ ] Establish a scheduled manual check cadence (daily) using OPERATOR_RUNBOOK.md; consider external uptime monitoring.

## 14. Rollback plan
- [x] Backend current deploy `33d40cb3-f454-44e8-bcbe-ddce13932f4f` (SUCCESS).
- [x] Frontend current deploy `bee2fda4-efa2-46f0-aec6-ea0dbbd16941` (SUCCESS).
- [ ] To roll back a service: use `railway redeploy -d <previous-successful-deployment-id>` (previous successful deploys are present for both services). No code change required to roll back.
- [ ] Prefer read-only diagnosis (logs + /health) before any restart action; restarts are non-destructive.

## Launch gate note
Application is **READY for non-payment usage**. Payment automation is **NOT AVAILABLE YET** (zero-admin blocked by missing trusted provider verification). Launch paid/first-customer flow only after the helper payment verification path exists, or explicitly with a manual-verification support process (see ZERO_ADMIN_PAYMENT_ROADMAP.md).
