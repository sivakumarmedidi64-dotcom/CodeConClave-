# CodeConClave — FINAL ZERO-ADMIN PAYMENT RUNTIME GATE

> Status: **PRE-APPROVAL ASSESSMENT** (no real payment made, no secrets exposed)
> Date: 2026-08-31
> This document verifies the exact source-level capability of the trusted
> automatic-verification rails and states precisely what is needed to reach
> zero-admin activation. It does **not** expose any secret values.

---

## 1. Trusted Rail Inventory (source-verified)

| Rail | Code status | Config status | Trust for auto-activation |
|------|-------------|---------------|---------------------------|
| RAZORPAY_API (mode=api) | PRESENT | BLOCKED (keys not set) | Trusted → can reach ACTIVE |
| RAZORPAY_WEBHOOK (push) | PRESENT | BLOCKED (secret not set; flag off) + **ROUTE SHADOWED BY AUTH** | Trusted → can reach ACTIVE |
| GMAIL_READER | PRESENT | SECONDARY (available if OAuth tokens configured) | Trusted → can reach ACTIVE |
| OCR / MANUAL | PRESENT | N/A | **NEVER** (forced to REVIEW) |

**Recommended production rail:** **SIGNED RAZORPAY WEBHOOK** (push, hands-off) as the
primary trusted confirmation, with **SERVER-SIDE RAZORPAY API reconciliation** as the
secondary/fallback trusted confirmation. Gmail remains a secondary evidence/reconciliation
rail only — it must not be the sole authority where a signed provider webhook/API is stronger.

---

## 2. Required Credentials (names only — values never shown)

- `RAZORPAY_KEY_ID` — required for RAZORPAY_API (mode `api`) + unique per-intent payment links.
- `RAZORPAY_KEY_SECRET` — required for RAZORPAY_API + webhook HMAC is separate (below).
- `RAZORPAY_WEBHOOK_SECRET` — required for the signed webhook rail (HMAC-SHA256).
- `RAZORPAY_WEBHOOK_ENABLED` — must equal `true` to enable the webhook rail (default `false`).

Gmail rail (secondary):
- `GMAIL_OAUTH_ACCESS_TOKEN`, or
- `GMAIL_OAUTH_REFRESH_TOKEN` **and** `GOOGLE_CLIENT_ID` **and** `GOOGLE_CLIENT_SECRET`.
- OAuth scope already requested in the live Google flow: `gmail.readonly`, `gmail.send`,
  `drive.file`, `spreadsheets`, `calendar.events`.

Source: `backend/src/config/env.ts:80-104`, `evidence.ts:196-199,331-378`.

---

## 3. Razorpay Webhook Endpoint (verified from source, not guessed)

- Full route: `POST {API_URL}/api/v1/payments/webhook/razorpay`
  → **`https://backend-production-95faa.up.railway.app/api/v1/payments/webhook/razorpay`**
- Handled by `paymentWebhookRoutes()` (`routes.ts:287`), mounted at `app.ts:212`.
- Body is consumed as raw bytes via `express.raw` (`app.ts:78`) so the HMAC-SHA256 signature
  is computed over the exact signed bytes.

**What to configure in Razorpay (Dashboard → Account & Settings → Webhooks → Add Webhook):**
- **URL (HTTPS):** `https://backend-production-95faa.up.railway.app/api/v1/payments/webhook/razorpay`
- **Events** — only the ones the code consumes (see §7):
  - `payment.captured`
  - `payment.authorized`
  - `payment_link.paid`
  - `payment.refunded`
  - `payment_link.payment_refunded`
- **Secret:** set the same value everywhere as `RAZORPAY_WEBHOOK_SECRET` (Railway variable).
- **Enable signature verification** (this is exactly the HMAC-SHA256 the code validates).

**CRITICAL — must fix before this rail can work:** the webhook route is currently
**shadowed by the auth-gated `/api/v1/payments` router**. See §10.

---

## 4. Razorpay API (server-side reconciliation)

- Present in code: `createRazorpayPaymentLinkForIntent` (`service.ts:110`) creates a **unique
  per-intent** Razorpay Payment Link (carrying the intent's `reference_id` + notes) when
  `RAZORPAY_KEY_ID`/`KEY_SECRET` are set; stores `provider_payment_link_id` + `provider_reference_id`.
- `razorpay_api` evidence source (`evidence.ts:331`) fetches `GET /v1/payments?count=50` and
  matches by `notes.reference`/`notes.session_id`; server-verified, **trusted** → can reach ACTIVE.
- Triggered by authenticated `POST /api/v1/payments/intents/:id/refresh` (`routes.ts:196`) or
  `POST /api/v1/payments/reconciliations` (founder, `routes.ts:235`).
- **Note:** `runReconciliation` (`reconciliation.ts`) only *reports* drift; it never auto-fixes.
  The API rail activates via the refresh path, not via reconciliation. So the API rail is
  pull/reconcile (server-side verified) rather than an automated push.

To enable: set `RAZORPAY_MODE=api`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` in Railway backend.

---

## 5. Per-Intent Correlation — PASS

- Server authoritatively generates `reference` = `CC{PLAN}-{6} ` (e.g. `CCPRO-XXXXXX`) per intent
  (`intents.ts:79-88`), unique via a UNIQUE constraint with collision retry (`intents.ts:103-134`).
- `amount`, `plan`, and `user` are all set server-side from `PLAN_PRICES_INR` and the
  authenticated session — **never client-supplied** (`intents.ts:90-134`).
- Unique Razorpay Payment Link per intent when API keys present
  (`createRazorpayPaymentLinkForIntent`), with `reference_id` = the intent reference and
  `notes.plan`/`notes.intent_id` (`service.ts:121-135`).
- Webhook resolves the intent via `provider_reference_id` / `provider_payment_link_id` /
  `reference` — trusted identifiers only, **never email-alone** (`routes.ts:358-392`).
- A plan that cannot be resolved is never auto-activated (`routes.ts:382-392`).

---

## 6. Plan + Amount Validation — PASS

- Server map: `PLAN_PRICES_INR = { pro: 999, team: 4999 }` (`service.ts:41`).
- Razorpay amounts arrive in paise: webhook divides by 100 and compares to the intent amount
  (`routes.ts:445-461`); API/verify path uses `evidenceAmountInr` and rejects on mismatch
  (`service.ts:322-334`).
- Expected: PRO ₹999 → 99900 paise; TEAM ₹4999 → 499900 paise.
- Any mismatch → rejected, recorded (amount_mismatch), **no entitlement** (`routes.ts:449-461`,
  `service.ts:323-334`).
- No cross-plan fallback: unknown/invalid plans fail safely (`service.ts:57-60`), and `pro`
  never falls back to `team` link (`service.ts:48-51`).

---

## 7. Webhook Security — PASS (implementation), BLOCKED (route reachability)

From `routes.ts:289-488` (webhook handler):

- **Signature validation:** HMAC-SHA256 over raw body with `RAZORPAY_WEBHOOK_SECRET`,
  compared via `timingSafeEqual`; invalid → 401 + audit `payment.webhook_signature_invalid`
  (`routes.ts:305-319`).
- **Event validation:** only `payment.captured` / `payment.authorized` / `payment_link.paid`
  may activate; `payment.refunded`/`payment_link.payment_refunded` revoke; all other events are
  recorded idempotently without state change (`routes.ts:394-441`).
- **Payment status validation:** only captured/authorized/paid events proceed to activation.
- **Amount validation:** claimed amount (paise) must equal intent amount (INR) (`routes.ts:445-461`).
- **Plan validation:** resolved from the server-authoritative intent row, never from the event alone.
- **User/reference correlation:** via trusted `provider_reference_id`/`provider_payment_link_id`/
  `reference`; email is never the binding key (`routes.ts:358-392`).
- **Idempotency:** `payment_webhook_events` keyed by `event_id` with `ON CONFLICT DO NOTHING`
  (`routes.ts:341-353`); intent-level no-op if already non-PENDING/REVIEW (`routes.ts:463-467`).
- **Replay protection:** per-event dedupe + `payment_evidence.sha256` replay guard across
  intents/owners (`pipeline.ts:114-131`) + fraud checks (`checkFraud`).

**BLOCKER:** see §10 — the webhook handler is currently unreachable because the auth-gated
payments router is mounted at a shorter prefix before it.

---

## 8. Automatic Entitlement — READY in code / BLOCKED at runtime

Path (webhook, trusted source):
```
Signed Razorpay webhook
  → signature + event + amount + plan validation
  → resolve exact intent (trusted id)
  → pipeline.ingestEvidence(..., 'razorpay_webhook', payload)
  → scoreEvidence → applyDecision (trusted source may reach ACTIVE)
  → activateEntitlement(): entitlement state = PRO_VERIFIED + users.plan_id set
    (service.ts:418-427, activation.ts)
```
- Trust boundary (`pipeline.ts:55`): `TRUSTED_EVIDENCE_SOURCES = {gmail, razorpay_api, razorpay_webhook}`.
  Only trusted sources reach ACTIVE; untrusted (ocr/manual) are forced to REVIEW
  (`effectiveMatch`, `pipeline.ts:66-78`).
- **No admin, no manual activation, no user assertion** needed for the trusted path —
  `razorpay_webhook` activation sets `PRO_VERIFIED` + plan directly (`routes.ts:471-487`).

**Runtime status:** blocked because (a) no real webhook secret/keys configured, and
(b) **the webhook route is shadowed by `requireAuth`** (see §10).

---

## 9. Gmail (secondary reconciliation rail)

- `GMAIL_READER` code present (`evidence.ts:196-199,260-282`), available when
  `GMAIL_OAUTH_ACCESS_TOKEN`, or refresh token + `GOOGLE_CLIENT_ID`/`SECRET`, are set.
- Gmail is a **trusted** source (in `TRUSTED_EVIDENCE_SOURCES`), so it can reach ACTIVE.
- The live Google OAuth flow already requests `gmail.readonly`/`gmail.send` scopes.
- **Role:** secondary reconciliation/evidence only. The signed webhook / API are the stronger
  authority; Gmail must not be the sole requirement where webhook/API are stronger
  (per instructions).

---

## 10. CRITICAL BLOCKER — Webhook route shadowed by requireAuth

- `app.ts:211`: `app.use('/api/v1/payments', paymentRoutes())` mounts a router whose first
  middleware is `router.use(requireAuth)` (`routes.ts:46`).
- `app.ts:212`: `app.use('/api/v1/payments/webhook', paymentWebhookRoutes())` mounts the webhook.
- Express matches middleware in registration order by path prefix. `/api/v1/payments` is a
  prefix of `/api/v1/payments/webhook/razorpay` and is registered first, so the webhook request
  enters the auth-gated router, where `requireAuth` rejects it (401) before ever reaching the
  webhook handler.
- CSRF is correctly exempt for the webhook (`csrf.ts:15`), so CSRF is **not** the cause.
- **Live proof:** `POST /api/v1/payments/webhook/razorpay` (valid raw body) and the protected
  `GET /api/v1/payments/entitlements` both return **401 empty-body** — identical behavior,
  confirming the webhook is behind the same auth gate. A server-to-server Razorpay webhook
  carries no session cookie, so it would be rejected with 401 and activate nothing.

**Fix required (code):** mount `paymentWebhookRoutes()` **before** `paymentRoutes()` in
`app.ts`, or scope the `requireAuth` in the payments router to exclude `/webhook/*`.

---

## 11. Railway Configuration (names only — values never shown)

Required variables in Railway backend:
- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`
- `RAZORPAY_WEBHOOK_ENABLED=true`
- `RAZORPAY_MODE=webhook` (or `api`)

Gmail (secondary, optional):
- `GMAIL_OAUTH_ACCESS_TOKEN` or (`GMAIL_OAUTH_REFRESH_TOKEN` + `GOOGLE_CLIENT_ID` +
  `GOOGLE_CLIENT_SECRET`).

I did **not** run `railway variable list` (would dump secrets). Current runtime capability was
confirmed via the live `GET /health` (storage/ai NOT_CONFIGURED) and route probes.

**Config-as-code disabled** in this workspace (`railway.toml` inert); env is managed via
Railway dashboard/CLI per-variable.

---

## 12. Deployment

- Fixing the webhook route shadowing (§10) is a **backend code change** → requires an
  approved backend redeploy (backend deploy `575c2d1b` currently live).
- Frontend must **not** be redeployed for this.
- Per instructions: **do not deploy reactively.** Await explicit approval.

---

## 13. Controlled Payment Test (NOT YET PERFORMED)

Required preconditions before any real payment:
1. Fix webhook route shadowing (§10) and redeploy backend (approved).
2. Add `RAZORPAY_WEBHOOK_SECRET` (+ keys, flag) to Railway backend and redeploy (approved).
3. Register the webhook URL + events in Razorpay, enable signature verification.
4. Confirm `GET /api/v1/payments/capabilities` shows webhook + api rails enabled.

Then request human approval for **exactly ONE controlled real payment: PRO ₹999**.
Expected: payment → signed webhook → verify → entitlement `PRO_VERIFIED`/ACTIVE → **no admin**.
TEAM ₹4999 may be tested afterward.

---

## 14. FINAL REPORT

```
RAZORPAY_API:             BLOCKED  (code PRESENT; no KEY_ID/SECRET configured; pull/reconcile rail)
RAZORPAY_WEBHOOK:         BLOCKED  (code PRESENT complete; not configured AND route shadowed by requireAuth)
GMAIL:                    SECONDARY (code PRESENT; enables when OAuth tokens configured; never sole authority)
PER_INTENT_CORRELATION:   PASS  (server-owned reference/amount/plan/user; unique per-intent link)
PLAN_VALIDATION:          PASS  (server map pro=999/team=4999; no cross-plan fallback)
AMOUNT_VALIDATION:        PASS  (paise→INR compare vs server amount; mismatch => reject, no entitlement)
SIGNATURE_VALIDATION:     PASS  (HMAC-SHA256 + timingSafeEqual over raw body)
IDEMPOTENCY:              PASS  (event_id dedupe + intent-state no-op + evidence sha replay guard)
REPLAY_PROTECTION:        PASS  (event dedupe + evidence replay cross-intent + fraud checks)
AUTO_ENTITLEMENT:         BLOCKED (code READY via trusted webhook/API; runtime blocked by config + route shadow)
MANUAL_ADMIN_NORMAL_PATH: NOT_REQUIRED for signed-webhook/API trusted path (PRO_VERIFIED auto);
                          REQUIRED only as review fallback for untrusted/ambiguous evidence
PAYMENT_CONFIG:           BLOCKED (needs RAZORPAY_KEY_ID/SECRET/WEBHOOK_SECRET + WEBHOOK_ENABLED=true)
DEPLOYMENT:               DEPLOYMENT_REQUIRED (backend redeploy after §10 fix + env; await approval)
CONTROLLED_PAYMENT:       APPROVAL_REQUIRED
REAL_PAYMENT:             NOT_PERFORMED
```

**Primary actionable blocker:** the signed Razorpay webhook rail is present and fully
implemented but cannot be reached because it is shadowed by the auth-gated `/api/v1/payments`
router (`app.ts:211` before `:212`). Fix the mount order (or scope `requireAuth`), add the
three Razorpay variables + `RAZORPAY_WEBHOOK_ENABLED=true`, redeploy backend (approved), then
proceed to the single controlled PRO ₹999 payment.
