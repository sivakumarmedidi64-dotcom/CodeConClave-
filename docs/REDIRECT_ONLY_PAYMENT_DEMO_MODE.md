# Redirect-Only Payment — DEMO MODE (strictly non-production)

> **STATUS: IMPLEMENTED (backend + frontend + tests), NOT DEPLOYED.**
> This document is the authoritative reference for the redirect-only **demo**
> payment flow. It exists to demonstrate the intended customer journey in
> development/staging **without** pretending that a browser redirect is payment
> proof.

---

## 1. Why this exists

CodeConClave has **no Razorpay API keys** and **no signed webhook**, so a real,
zero-admin, independent payment-verification rail is NOT possible yet. All prior
audits reached the same conclusion: `NO_API / NO_WEBHOOK / NO_ADMIN =
NOT_POSSIBLE`, and recommended `WAIT_FOR_RAZORPAY_CAPABILITY`.

This rail is the **interim demo/test flow** so the journey can be exercised and
demonstrated safely. It is **not a production payment method** and **never**
verifies a real payment.

## 2. The one hard rule

> **A browser redirect, query parameter, cookie, or frontend flag is NEVER
> payment proof.**

- An activation email click proves **EMAIL OWNERSHIP** only — it proves
  **PAYMENT OCCURRED = NO**.
- There is **no production entitlement** in the demo rail.
- There is **no "payment verified"** label anywhere in the demo rail. The only
  label is **DEMO ACTIVATION**, recorded as:
  - `payment_verification_method = DEMO_REDIRECT`
  - `is_real_payment = false`

## 3. Production guard (server-side, hard)

The demo rail runs **only** when:

```
DEMO_PAYMENT_MODE === 'true'  AND  NODE_ENV !== 'production'
```

and, when `DEMO_PAYMENT_ALLOWLIST` is set, the caller's email must be on it.

Every demo entrypoint re-checks `demoModeEnabled()` **server-side**. A frontend
env var, a cookie, or a query parameter **can never** enable it. In production
each endpoint returns **403 `demo_mode_disabled`** with the exact message:

> Redirect-only payment verification is disabled in production.

## 4. Flow

```
1. POST /api/v1/payments/demo/session        (requireAuth + CSRF)
     body { planId: 'pro'|'team' }
     -> server encodes server-authoritative price into an HMAC-SHA256
        signed, short-lived demo session token
     (NOT a redirect target; NOT payment proof)

2. GET  /api/v1/payments/demo/return?s=<signed>   (requireAuth)
     -> server validates signature/expiry/plan/amount/user, then issues a
        one-time activation token (SHA-256 hashed at rest in the cache
        store, rate-limited, short-lived) and enqueues a DEMO-labeled email

3. POST /api/v1/payments/demo/activate          (requireAuth + CSRF)
     body { token }
     -> server consumes the one-time token, binds it to the owning account,
        and records DEMO_ACTIVATED with
        payment_verification_method=DEMO_REDIRECT, is_real_payment=false
```

## 5. Signed demo session

- HMAC-SHA256 over server-only secret (dedicated `DEMO_SESSION_SECRET`, else a
  hash of `SESSION_SECRET`).
- Claims: `sessionId, userId, email, plan, amountInr, demo=true, issuedAt,
  expiresAt`.
- Server validates: signature (timing-safe), expiry, plan, **amount (from
  `PLAN_PRICES_INR` — never client-supplied)**, and (by default) user binding.
- The session token is **NOT payment proof**; it is only a bound, non-production
  demo intent.

## 6. One-time activation token

- Cryptographically random (32 bytes), **SHA-256 hashed at rest** in the
  cache/Redis store (no DB schema change; demo state is kept out of the
  production entitlement tables).
- Short-lived (`DEMO_ACTIVATION_TTL_SECONDS`, default 1800s), **single-use**
  (exactly-once), per-user **rate-limited**
  (`DEMO_ACTIVATION_MAX_PER_HOUR`, default 3), **replay-protected** (expiry +
  one-time), and **bound** to the user/session/plan it was issued for.
- Proves **EMAIL OWNERSHIP only** — never `PAYMENT_OCCURRED`.

## 7. Where state lives

- The **signed demo session** is stateless (HMAC-signed).
- The **activation token record** lives in the **Redis/in-memory cache store**.
  This deliberately avoids any DB schema change and keeps demo state out of the
  production `entitlements`/`users` tables (whose CHECK constraints already
  reject demo states).

## 8. What is intentionally NOT done

- No production entitlement, no `VERIFIED`, no real account upgrade.
- Manual/OCR/Gmail evidence behavior is **unchanged** (manual/OCR remain
  REVIEW-only).
- Production payment code (Razorpay API rail, webhook rail, Gmail evidence,
  plan/amount validation, idempotency, replay protection, anti-self-activation)
  is **frozen and untouched**.

## 9. Files

| Path | Purpose |
|---|---|
| `backend/src/config/env.ts` | demo env vars |
| `backend/src/modules/payments/demo.ts` | signed session + activation token logic, production guard |
| `backend/src/modules/payments/demo-routes.ts` | `/api/v1/payments/demo/*` routes |
| `backend/src/app.ts` | mounting |
| `backend/src/foundation/demo.test.ts` | 21 regression tests |
| `frontend/src/pages/DemoPaymentActivatePage.tsx` | DEMO activation page (visible warning) |
| `frontend/src/App.tsx` | route wiring |

## 10. Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `DEMO_PAYMENT_MODE` | `false` | master switch (`'true'` to enable, non-prod only) |
| `DEMO_PAYMENT_ALLOWLIST` | `''` | optional comma-separated email allowlist |
| `DEMO_SESSION_SECRET` | (derived from `SESSION_SECRET`) | server-only HMAC secret |
| `DEMO_SESSION_TTL_SECONDS` | `600` | signed session TTL |
| `DEMO_ACTIVATION_TTL_SECONDS` | `1800` | activation token TTL |
| `DEMO_ACTIVATION_MAX_PER_HOUR` | `3` | per-user rate limit |

## 11. Verification

- `npm run typecheck`, `npm run build`, `npm test` pass.
- `src/foundation/demo.test.ts` (21 tests) covers: demo off/on, production
  refusal, allowlist, signed-session tamper/expiry/plan/amount/user/non-demo
  failures, activation single-use/expiry/binding/rate-limit, and correct
  `DEMO_REDIRECT` / `is_real_payment=false` labeling.
