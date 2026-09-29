# CodeConClave — FINAL RAZORPAY WEBHOOK ROUTE FIX

> Date: 2026-08-31
> Scope approved: webhook route fix + backend redeploy ONLY. No new features, no
> payment made, no secrets exposed, frontend + worker untouched.

---

## 1. Problem

`POST /api/v1/payments/webhook/razorpay` returned 401 because the authenticated
payments router (`paymentRoutes()`, whose first middleware is `requireAuth`) was
mounted at `/api/v1/payments` BEFORE the dedicated webhook router
(`paymentWebhookRoutes()`) at `/api/v1/payments/webhook`. Express matches mounts
in registration order by path prefix, so the webhook (no session cookie) was
intercepted and auth-rejected before it ever reached the webhook handler.

---

## 2. Route Order — BEFORE vs AFTER

**Before (`backend/src/app.ts`):**
```ts
app.use('/api/v1/payments', paymentRoutes());          // requireAuth gate
app.use('/api/v1/payments/webhook', paymentWebhookRoutes());
```

**After (fixed):**
```ts
app.use('/api/v1/payments/webhook', paymentWebhookRoutes());   // mounted FIRST
app.use('/api/v1/payments', paymentRoutes());
```

The webhook path now reaches the dedicated handler before the auth-gated router.
`requireAuth` remains on the normal payments router; authentication for normal
routes is unchanged. No other route, CSRF rule, or security middleware was modified.

---

## 3. Security Behavior (verified)

- Normal `GET /api/v1/payments/entitlements` (no session) → **401** (auth enforced).
- Normal `POST /api/v1/payments/sessions` (no session, no CSRF) → **403** (CSRF+auth enforced).
- Webhook POST (no session cookie) → reaches the webhook router. With the rail
  currently disabled it returns **404 "Webhook not configured"** — NOT the old auth-shadow 401.
- Once the rail is enabled (`RAZORPAY_WEBHOOK_ENABLED=true` + `RAZORPAY_WEBHOOK_SECRET`),
  the handler: verifies HMAC-SHA256 signature (`timingSafeEqual`), validates
  event/amount/plan, resolves the intent by trusted reference, applies
  idempotency + replay protection, and auto-activates only trusted sources
  (`razorpay_webhook` → ACTIVE). Invalid/missing signature is rejected.
- CSRF exemption for the webhook was already correct (`csrf.ts` EXEMPT_PREFIXES includes
  `/api/v1/payments/webhook`) and is unchanged.

---

## 4. Tests

New regression file (pins the route-ordering defect at the assembled-app level):

- `backend/src/foundation/payments-webhook-route.test.ts`
  - webhook path reaches the webhook router without a session cookie (expects
    404 `not_found` — i.e. NOT the auth-shadow 401).
  - normal `/api/v1/payments/*` route without auth still returns 401.
  - normal state-changing `/api/v1/payments/*` route without auth/CSRF is rejected (403).

The new regression test was confirmed to **FAIL when the bug is present** (mount order
reverted) and **PASS with the fix**, proving it detects the defect.

Webhook handler-level controls were already covered and still pass in
`payments-26h.test.ts` (invalid signature rejection, valid signature auto-activation,
duplicate-event idempotency, amount mismatch, plan authority, fabricated/OCR/weak
evidence forced to REVIEW, cross-user/tenant isolation, replay guard).

### Test / build results
- Payment tests (5 files, incl. new route test): **122 passed**
- Security tests (6 files): **143 passed**
- Full backend suite: **98/99 files passed, 1777 passed, 3 skipped** — the single
  failure was `perf-17.test.ts` (performance smoke, wall-clock threshold), which
  passes in isolation; a timing flake, unrelated to this routing change.
- `npm run typecheck`: **PASS**
- `npm run build`: **PASS**

---

## 5. Deployment

- Backend redeployed to the existing production service via `railway up`
  (project `82dd1698…`, env `production`, service `backend`).
- Deployment `fabba1b5-6bc9-4682-96fd-c4437c058385` → **SUCCESS**.
- Frontend: **UNCHANGED** (still deploy `925ed179`, serving 200).
- Worker: **UNCHANGED** (not deployed).

---

## 6. Post-Deploy Verification

| Check | Result |
|-------|--------|
| `/healthz` | 200 `{"ok":true}` |
| `/health` | 200 (status DEGRADED — expected) |
| Webhook POST without session cookie | **404** ("Webhook not configured") — not the old auth 401 → ROUTE_REACHABLE |
| `GET /api/v1/payments/entitlements` (no auth) | 401 (auth still enforced) |
| `POST /api/v1/payments/sessions` (no auth/CSRF) | 403 (still rejected) |
| Frontend `/` and `/health` | 200 (proxy OK, UI unchanged) |

**ROUTE_REACHABLE = YES**, **SIGNATURE_REQUIRED = YES** (handler is the only entry; it will
reject unsigned when the rail is enabled), **UNSIGNED_REQUEST = REJECTED** (404 while disabled;
signature-rejected when enabled).

---

## 7. Webhook Configuration (HUMAN_ACTION_REQUIRED)

The code fix is deployed, but the webhook is not yet enabled in this environment
(`RAZORPAY_WEBHOOK_ENABLED` not `true`, no `RAZORPAY_WEBHOOK_SECRET` set). To arm the rail:

- Add to Railway backend: `RAZORPAY_WEBHOOK_ENABLED=true`, `RAZORPAY_WEBHOOK_SECRET=<secret>`
  (store securely; never print). Requires an approved redeploy to take effect.
- Razorpay dashboard → Account & Settings → Webhooks → Add Webhook:
  - URL (HTTPS): `https://backend-production-95faa.up.railway.app/api/v1/payments/webhook/razorpay`
  - Events: `payment.captured`, `payment.authorized`, `payment_link.paid`,
    `payment.refunded`, `payment_link.payment_refunded`
  - Enable signature verification (same secret).
- API (`RAZORPAY_KEY_ID`/`KEY_SECRET`) remains optional/secondary for the reconciliation
  rail; the signed webhook is the primary automatic rail.

**HUMAN_ACTION_REQUIRED** for the above dashboard + env configuration.

---

## 8. Zero-Admin Payment Status

- WEBHOOK_ROUTE = **FIXED** (deployed + verified reachable)
- WEBHOOK_CONFIG = **NOT READY** (env + dashboard not yet configured — HUMAN_ACTION_REQUIRED)
- AUTO_ACTIVATION_PATH = **READY in code** (trusted `razorpay_webhook` → ACTIVE), not yet
  armed in config.

**STOPPING**: no real payment was made and none will be made until the webhook is configured
and a human approves the single controlled PRO ₹999 test.

---

## 9. Final Report

```
# CODECONCLAVE RAZORPAY WEBHOOK ROUTE FIX

Route fix:             APPLIED
Webhook route:         REACHABLE  (404-not-configured now, not auth 401)
Auth middleware bypass for webhook: YES  (webhook router mounted before auth-gated payments router; requireAuth untouched on normal routes)
Signature verification: PASS  (HMAC-SHA256 timingSafeEqual; handler-reachable)
Unsigned webhook:      REJECTED  (404 while disabled; will be signature-rejected when enabled)
Normal payment routes: AUTH_REQUIRED  (401 GET / 403 POST)
Idempotency:           PASS
Plan validation:       PASS
Amount validation:     PASS
Manual evidence bypass: FIXED  (fabricated/OCR/weak never ACTIVE; REVIEW only)
Typecheck:             PASS
Build:                 PASS
Backend deployment:    SUCCESS  (fabba1b5)
/healthz:              PASS  (200)
/health:               PASS  (200, DEGRADED expected)
AUTO_ACTIVATION_PATH:  READY in code / BLOCKED by config (webhook env + dashboard not yet set)
CONTROLLED_PAYMENT:    APPROVAL_REQUIRED
REAL_PAYMENT:          NOT_PERFORMED
Frontend:              UNCHANGED
Worker:                UNCHANGED
```
