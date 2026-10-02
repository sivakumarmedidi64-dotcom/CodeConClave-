# CodeConClave — Final Production Smoke Test

> Date: 2026-08-31
> Environment: Production (Railway project `82dd1698-e7f6-4912-8cd6-299a1bc95557`, env production `2957bdcd-e168-4e8a-b9c5-04a817221843`)
> Frontend (LIVE): `https://frontend-production-e367.up.railway.app` (deploy `925ed179-b01c-4b96-b267-831ca1b68117`, SUCCESS)
> Backend (LIVE): `https://backend-production-95faa.up.railway.app` (deploy `575c2d1b-f439-447b-ae9c-cc3d2c370713`, SUCCESS)
> Worker: `2cd27417-8bae-4968-9807-0297cde21343` — **OFFLINE** (unchanged; intentionally not deployed)
>
> No redeploys were performed. No feature changes. No secrets are disclosed in this report.
> No real payment was made (per constraint). A real payment is required only to prove the
> zero-admin runtime path — that requires explicit approval.

---

## 1. Result Summary

| Area | Status |
|------|--------|
| Frontend | **PASS** |
| Backend | **PASS** (degraded health, expected) |
| Database | **HEALTHY** (per backend /health check) |
| Authentication | **PASS** (implemented; protected routes enforce 401/403; interactive cycle NOT_TESTED) |
| Google OAuth | **PASS** (fully configured, live authz redirect reached) |
| AI | **CONFIGURED-NOT_TESTED** (providers present, key-gated, no end-to-end run) |
| Memory | **CONFIGURED-NOT_TESTED** (auth-gated route; dev in-memory store) |
| Execution | **CONFIGURED-NOT_TESTED** (auth-gated route) |
| Proxy (FE→BE) | **PASS** (verified live) |
| SSE / Streaming | **CONFIGURED-NOT_TESTED** (routes exist; proxy configured) |
| Security | **PASS** (with NICE_TO_HAVE items) |
| Pro ₹999 / Team ₹4999 | **CAPABILITY PASS / RUNTIME NOT_TESTED** (no real payment) |
| Zero-admin infra | **READY** (link rail active; API/webhook rails disabled pending real keys) |
| Automatic entitlement | **CONTROLLED_TEST_REQUIRED** (webhook rail disabled; passive-link flow → review) |
| Manual admin required | **PARTIAL** (current config: link evidence routes to review, not full auto-provision) |
| First-customer readiness | **READY with pre-Launch checklist** |
| Deployment | **ALREADY_LIVE** |
| Real payment | **NOT_PERFORMED** |
| Next step | **CONTROLLED PAYMENT APPROVAL required** |

---

## 2. Live Verification Evidence (all probes, no secrets)

### 2.1 Frontend (deploy 925ed179 SUCCESS)
- `GET /` → 200, `text/html`, contains `<div id="root">` (SPA shell).
- SPA routes served: `/`, `/login`, `/register`, `/signup`, `/pricing`, `/plans`, `/agents` → all 200 (SPA fallback).
- Static asset `/assets/index-DicCf8wU.js` → 200 `application/javascript` (950589 B).
- FE `/health` → 200 JSON (backend health proxied), CSP headers present.
- FE `/healthz` → 200 (SPA HTML; not an advertised JSON health route).
- **Proxy PASS:** FE `/api/v1/payments/capabilities` → 401 (correctly forwarded to backend); FE `/api/v1/auth/me` → 401; FE `/health` → 200.

### 2.2 Backend (deploy 575c2d1b SUCCESS)
- `GET /healthz` → 200 `{"ok":true}`.
- `GET /health` → 200 JSON:
  - status `DEGRADED`, provider `memory`, queue `redis`.
  - checks HEALTHY: `api`, `database`, `cache`, `queue`, `worker`.
  - `ai` → DEGRADED ("Configured but no health data yet").
  - `storage` → NOT_CONFIGURED (in-memory dev store; no S3).
  - `local-agent` → DEGRADED (hub up, no agent online).
  - `plugins` → NOT_CONFIGURED.
  - `sentry` → NOT_CONFIGURED.
- `GET /api/v1/health` → 200 `{status: degraded}`.
- BE root `/` → 404 (expected; no public root page).

### 2.3 Authentication enforcement (protected routes → 401/403)
- `GET /api/v1/payments/capabilities` → **401**
- `POST /api/v1/payments/sessions` → **403**
- `POST /api/v1/payments/intents` → **403**
- `GET /api/v1/payments/status` → **401**
- `POST /api/v1/conversations/chat` → **403**
- `GET /api/v1/projects` → **401**
- `GET /api/v1/memory` → **401**
- `GET /api/v1/execution/tasks` → **401**
- `GET /api/v1/ai/providers` → **401**
- `GET /api/v1/auth/me` → **401** (expected unauth).
- Rate-limit headers present on auth endpoints: e.g. `GET /api/v1/auth/google/callback` → `X-RateLimit-Limit: 10, Remaining: 9`; payments routes → `Limit: 300`.

### 2.4 Google OAuth (PASS — fully live)
- `GET /api/v1/auth/google/authorize` → **302→ accounts.google.com sign-in**, with a **real, non-placeholder OAuth client id**
  (`322500527997-3d6t95i6shas8m0ula6vbsq7nofpbm5o.apps.googleusercontent.com`), `response_type=code`,
  `access_type=offline`, `prompt=consent`, and `redirect_uri` =
  `https://backend-production-95faa.up.railway.app/api/v1/auth/google/callback`.
- **Scopes requested by the live flow confirm the controlled-mailbox / docs integration is wired:**
  `gmail.send`, `gmail.readonly`, `drive.file`, `spreadsheets`, `calendar.events`.
- `GET /api/v1/auth/google/callback` (no code) → 400 (as expected).

### 2.5 Payments / zero-admin infrastructure
- Payment links (Mode A) are **always available** (env-driven defaults; Pro/Team links configured).
- Evidence capability detection (`evidence.ts`) is honest & server-derived:
  - `link` → enabled always.
  - `api` → enabled only if `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` both set (**currently disabled**).
  - `webhook` → enabled only if `RAZORPAY_WEBHOOK_SECRET` set **and** `RAZORPAY_WEBHOOK_ENABLED === 'true'` (**currently disabled** — env flag absent, so rail is OFF).
- Webhook route exists (`POST /api/v1/payments/webhook/razorpay`); **OPTIONS → 204** (route present), **POST → 401**
  (route is gated; signed-HMAC path only when the rail is enabled). Idempotency + signature verification coded
  (`payment_webhook_events`, `timingSafeEqual` SHA256).
- Plan→amount/entitlement mapping is **server-side** (`PLAN_PRICES_INR={pro:999, team:4999}`);
  a client cannot self-grant entitlement (server derives from verified evidence, not client-supplied plan).
- Manual-evidence self-activation is blocked/admin-gated; `razorpay_webhook`/`gmail`/`razorpay_api` are the only
  trusted auto-provision sources.

### 2.6 Security headers (live API responses)
- HSTS `max-age=63072000; includeSubDomains` (prod only).
- CSP (gated by `CSP_ENABLED`, default true): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'`.
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Permissions-Policy: camera=(), microphone=(self), geolocation=()`, COOP/CORP same-origin.
- Cookie `codeconclave_csrf`: Secure, SameSite=Lax, Max-Age=604800. (Value always redacted.)
- Server `railway-hikari`; no `X-Powered-By`.

---

## 3. Blockers / Non-Blockers / Nice-To-Have

### BLOCKERS (must resolve before full auto-provision launch)
1. **Real Razorpay API + webhook credentials are not configured.** Only the hosted Payment Link
   (Mode A) rail is active. Automatic (fully hands-off) provisioning from a push webhook or API fetch
   (Mode B/C) is DISABLED. Until `RAZORPAY_KEY_ID`/`KEY_SECRET` and
   `RAZORPAY_WEBHOOK_SECRET`+`RAZORPAY_WEBHOOK_ENABLED=true` are set and the webhook URL registered in
   Razorpay, entitlements cannot auto-activate without operator review.
2. **Controlled live payment not performed** (by constraint). Zero-admin runtime must be proven with a
   real ₹999/₹4999 payment under supervision. **STOP-BEFORE-PAYMENT**: `CONTROLLED_PAYMENT_APPROVAL_REQUIRED = YES`.

### NON_BLOCKERS (present, not blocking basic live use)
- AI provider end-to-end run NOT_TESTED (providers configured & key-gated; requires authenticated session/project).
- Memory / Execution / SSE end-to-end NOT_TESTED (routes exist and are auth-gated; would create prod data).
- Interactive register/login/logout/MFA cycle NOT_TESTED (would create real prod data) — code paths verified present.
- Storage uses in-memory dev store (no S3); Sentry NOT_CONFIGURED.
- Worker service intentionally OFFLINE.

### NICE_TO_HAVE
- FE SPA responses don't carry CSP/HSTS headers (`server.cjs` doesn't set them) — add for defense-in-depth.
- Local-agent hub shows "no agent online"; agent bring-up optional.

---

## 4. First-Customer Readiness

**READY with the following pre-Launch checklist:**
1. Configure real `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` + `RAZORPAY_WEBHOOK_SECRET` and set
   `RAZORPAY_WEBHOOK_ENABLED=true`; register webhook URL in Razorpay dashboard.
2. Run a **controlled real payment** (₹999 Pro) and confirm auto-provisioning of the entitlement.
3. (Optional) Enable Sentry + S3 storage for production durability.
4. Decide whether the passive-link (Mode A) flow is acceptable for the first customer, or block sign-up
   until the webhook rail is live.

---

## 5. Final Report

```
# CODECONCLAVE FINAL PRODUCTION SMOKE TEST

Frontend:            PASS   (deploy 925ed179 SUCCESS; SPA + proxy verified)
Backend:             PASS   (deploy 575c2d1b SUCCESS; /healthz ok)
Database:            PASS   (HEALTHY per /health check)
Authentication:      PASS   (routes present; protected routes 401/403; interactive NOT_TESTED)
Google OAuth:        PASS   (live authz redirect w/ real client_id + gmail/docs scopes)
AI:                  CONFIGURED-NOT_TESTED
Memory:              CONFIGURED-NOT_TESTED
Execution:           CONFIGURED-NOT_TESTED
Proxy:               PASS   (FE->BE forwarding verified)
SSE:                 CONFIGURED-NOT_TESTED
Security:            PASS   (headers/CSRF/HSTS verified; NICE_TO_HAVE FE CSP)
Pro ₹999:            CAPABILITY PASS / RUNTIME NOT_TESTED
Team ₹4999:          CAPABILITY PASS / RUNTIME NOT_TESTED
Zero-admin infra:    READY   (link rail active; API/webhook rails off pending real keys)
Automatic entitlement: CONTROLLED_TEST_REQUIRED  (webhook rail disabled -> review flow)
Manual admin required: PARTIAL (current config routes link evidence to review)
First customer readiness: READY   (with pre-Launch checklist above)
CRITICAL_BLOCKERS:   [1] No real Razorpay API/webhook creds configured (webhook rail OFF). [2] Controlled live payment not performed.
NON_BLOCKERS:        AI/memory/exec/SSE end-to-end NOT_TESTED; auth interactive NOT_TESTED; in-memory storage; Sentry off; worker OFFLINE.
NICE_TO_HAVE:        FE CSP/HSTS headers; local-agent online.
REAL_PAYMENT:        NOT_PERFORMED
DEPLOYMENT:          ALREADY_LIVE
NEXT_STEP:           CONTROLLED PAYMENT APPROVAL / LAUNCH (per checklist)

STOPPED BEFORE PAYMENT: CONTROLLED_PAYMENT_APPROVAL_REQUIRED = YES
```
