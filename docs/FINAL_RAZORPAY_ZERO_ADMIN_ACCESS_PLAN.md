# FINAL RAZORPAY ZERO-ADMIN ACCESS PLAN

> **Scope:** Determine the safest provider-access path to ONE trusted Razorpay
> capability that enables secure zero-admin automatic payment activation.
> **No deployment. No real payment. No source-code changes. No fabricated
> traffic/customers. No bypass of Razorpay verification.**
> No secret values are printed in this document.

---

## 0. Executive summary

| Question | Answer |
|---|---|
| Can the current 2 static Payment Links achieve zero-admin? | **No** — static links carry no per-user reference, so a payment cannot be correlated to a CodeConClave account, and Gmail cannot safely bridge that gap. |
| Minimum trusted capability required? | **Razorpay API** (`RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET`) — used to create **per-intent dynamic Payment Links** with a unique `reference_id`, the correlation mechanism. |
| Recommended capability? | **API + Webhook** — API to create unique links; webhook (`/api/v1/payments/webhook/razorpay`) for instant, signed auto-activation. Both are already implemented in CodeConClave. |
| Can webhook-only work? | **No** — a webhook from a static link has no unique binding to a user. Webhook needs per-intent links, which require the API. |
| Can API-only work? | **Yes** — the existing watchdog already polls `GET /payments` and auto-activates matched intents (trusted `razorpay_api` source), ~15s latency. |
| What does the operator need to do first? | Complete KYC / account activation, then **provide verified website details** (with all required policy pages live), THEN generate Live Mode API keys. |
| Website status? | Public SPA is live, but the required **policy/pricing pages do not exist** as real content → **HUMAN_ACTION_REQUIRED**. |
| Deployment/real payment? | **NO CHANGE / NOT PERFORMED.** |

---

## 1. Current implementation audit (what CodeConClave ALREADY supports)

All components below are implemented in `backend/` and verified.

| Component | Status | Where |
|---|---|---|
| Per-intent payment references | ✅ Implemented | `CCPRO-XXXXXX` / `CCTEAM-XXXXXX` — `intents.ts` `makeReference()` |
| Dynamic payment-link creation | ✅ Implemented | `createRazorpayPaymentLinkForIntent()` sets `reference_id: <unique ref>`, `callback_url`, `notes {intent_id, plan}` — `service.ts:110` |
| Razorpay webhook | ✅ Implemented (latent) | `POST /api/v1/payments/webhook/razorpay` — HMAC-SHA256 verify, event idempotency, intent resolution via `provider_reference_id` / `provider_payment_link_id` / `reference` — `routes.ts:287` |
| Razorpay API verification | ✅ Implemented (latent) | `razorpayApiSource()` + `verifyWithProvider()` + `refreshIntentEvidence(['gmail','razorpay_api'])` — `evidence.ts:331`, `service.ts:266` |
| Gmail fallback (secondary) | ✅ Implemented | `gmailSource()` with DKIM/SPF/DMARC origin gate + exact-reference binding — `evidence.ts:262` |
| Entitlement activation | ✅ Implemented | `activateEntitlement()` (shared hook) — `service.ts:418`; `applyDecision()` exactly-once — `activation.ts:37` |
| Idempotency | ✅ Implemented | webhook event-level `payment_webhook_events` (unique `event_id`); evidence `signalSha256` replay guard |
| Replay protection | ✅ Implemented | timestamp-independent; duplicate payment-id / `screenshot_replay` / `reference_reuse` fraud flags |
| Plan/amount validation | ✅ Implemented | `PLAN_PRICES_INR` (₹999/₹4999), `amount_mismatch` reject in `service.ts` + `fraud.ts` |
| Anti-self-activation | ✅ Implemented | `manual`/`ocr` forced to REVIEW (`effectiveMatch`); only trusted sources (`gmail`, `razorpay_api`, `razorpay_webhook`) can reach ACTIVE |
| Tenant isolation | ✅ Implemented | intent owner-scoping, RLS, evidence `owner_id` checks |
| Audit logging | ✅ Implemented | `recordAudit()` on every path |

**Gating reality:** The API/webhook/gmail *rails are implemented and latent* — they activate automatically when the corresponding credentials are configured. The webhook route is **live and reachable** (see §4). The only missing piece is **Razorpay access (Live keys) to make the API/webhook rails operational**.

---

## 2. Minimum required Razorpay capability

The one capability that unlocks everything is the ability to create **unique per-intent dynamic Payment Links** — that requires the **Razorpay API**.

Reasoning (why webhook-only is not a valid minimum):

- A webhook event must be resolvable to the **exact user/plan/intent**. CodeConClave resolves via `payment_link.entity.reference_id` / `provider_payment_link_id` / internal `reference`.
- The **2 static Payment Links share one generic reference** across all customers → no per-user binding → a webhook from them goes to **REVIEW**, never auto-activates.
- The only way to get a **unique reference per customer** is to call the API `POST /payment_links` with a unique `reference_id` (already implemented in `createRazorpayPaymentLinkForIntent`).
- Therefore a **webhook requires the API** to be meaningful. Webhook-only is impossible.

**Conclusion:**

- **MINIMUM_REQUIRED_CAPABILITY = RAZORPAY API** (`RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET`).
- **RECOMMENDED (also has both) = API + WEBHOOK** — API for unique links, webhook for instant signed activation. Matches the objective's preferred order but recognizes that the webhook's value depends on API-created links.
- **OPTIONAL / SECONDARY = GMAIL** — keep as reconciliation; it does not solve static-link correlation (as required).

> Note on verification latency with API-only: the existing watchdog runs every
> 15s and polls `GET /payments` for PENDING/REVIEW intents, auto-activating
> matched ones. This is secure zero-admin; the webhook just makes it
> near-instant and removes reliance on polling.

---

## 3. Razorpay account requirements (current official behavior)

Source: official Razorpay docs (Business Website Details; API Keys Generator; Quickstart; Test & Live Modes; Go-live Checklist). No requirements are invented; verify in-dashboard as flows may vary.

### 3.1 KYC / account activation (live money)
- Sign up → submit **KYC** (CKYC/Video KYC). Approval typically ~1–4 business days.
- **Live Mode unlocks after KYC completion** and the operations team activates the account.

### 3.2 Website verification (the gate to Live API keys)
- To generate **Live Mode API keys** you MUST have **verified website/app details** in the Dashboard. Without them the Live "Generate Key" option is unavailable.
- Verification is done by the Razorpay team, typically **within 3 working days**.
- `Account & Settings → Website and app settings → Business website detail → Add website/app details`.

### 3.3 Pages Razorpay expects on the submitted website
From "Business Website Details": you are prompted for these pages:
1. **About us**
2. **Contact us**
3. **Pricing details**
4. **Terms and conditions**
5. **Privacy policy**
6. **Cancellation and Refund policy**
7. **Shipping / delivery / provisioning policy** — for a digital SaaS, a service-provisioning / non-refundable-digital-goods policy where applicable.

Also requested at submission:
- Upload a **sample invoice** (PNG / JPG / PDF).
- Whether the website **requires login to complete payment** (select accordingly; CodeConClave does gated checkout behind account login on dynamic links).

### 3.4 Live Mode API keys
- After website verification + KYC, generate keys:
  `Account & Settings → API Keys (Website and app settings) → switch to Live Mode → Generate Key`.
- Capture `key_id` (visible) and **`key_secret` (shown only once at generation)** — save securely, env-vars only.

### 3.5 Webhook (recommended, already implemented)
- `Account & Settings → Webhooks → + Add New Webhook`.
- Enter the public HTTPS endpoint (see §4).
- Set a strong **Webhook Secret (≥32 random chars)** — this becomes `RAZORPAY_WEBHOOK_SECRET`.
- Subscribe to **`payment.captured`** (and `payment_link.paid`) + refund/dispute events for lifecycle handling.
- Requires HTTPS + a valid TLS cert and DNS resolving for the webhook hostname (Railway provides HTTPS automatically).

---

## 4. Webhook route (already live)

Verified live against the deployed backend (this task):

- `POST https://backend-production-95faa.up.railway.app/api/v1/payments/webhook/razorpay`
  - Returns **`404`** with body `Webhook not configured` when called without `RAZORPAY_WEBHOOK_SECRET`/`RAZORPAY_WEBHOOK_ENABLED` — i.e. the route is **reachable**, mounted **before** the auth-gated payments router (no 401 auth-shadowing), and is currently inert as designed. The route **already exists**; no new route is created.
- Backend `/health` → `200`, DB / Redis / queue / worker **HEALTHY** (overall DEGRADED only because optional object-storage/plugins are unconfigured — non-blocking for payments).

No webhook secret is printed here.

---

## 5. API — credentials the operator creates

Only two credential values are needed, stored as env vars (never printed here):
- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`

**Where created:** Razorpay Dashboard → `Account & Settings → API Keys → Live Mode → Generate Key`.
**Prerequisite:** completed KYC + verified website details (§3.2–3.3).

---

## 6. Payment links — dynamic per-intent is required

- **DYNAMIC_PAYMENT_LINKS_REQUIRED = YES.**
- The **2 static links remain** for backward compatibility / manual fallback, but for TRUE zero-admin activation the production flow must create **one unique Payment Link per intent** via the API (`createRazorpayPaymentLinkForIntent`, already implemented), which injects:
  - a unique `reference_id` (the intent reference) — the webhook/API correlation key,
  - `notes` (intent/plan), and
  - the callback URL.
- This is what lets the webhook (and the API poll) resolve the payment to the exact user → auto-activate with zero admin.

---

## 7. Website — HUMAN_ACTION_REQUIRED

The Site is publicly deployed (`https://frontend-production-e367.up.railway.app`). Verified this task:
- All of `/pricing`, `/terms`, `/privacy`, `/refund`, `/cancel`, `/about`, `/contact` return the **SPA shell (`index.html`, 534 bytes)** — they are **NOT real content pages**; the React app has no routes for them and renders `NotFoundPage` (`App.tsx` catch-all `*`).

Razorpay's website-verification form asks for these pages, so the following are **HUMAN_ACTION_REQUIRED** (real, honest content — not fabricated customer claims):

| Page | Status | Action |
|---|---|---|
| Homepage | ✅ Live (login shell) | none |
| Pricing details | ❌ Missing | create `/pricing` (₹999 PRO / ₹4999 TEAM) |
| Terms and conditions | ❌ Missing | create `/terms` |
| Privacy policy | ❌ Missing | create `/privacy` |
| Cancellation and Refund policy | ❌ Missing | create `/refund` |
| Contact / support | ❌ Missing | create `/contact` |
| About us | ❌ Missing | create `/about` |
| Shipping/delivery/provisioning policy | ❌ Missing (if applicable) | create as needed for digital service |

> **Do not fabricate customers/traffic.** List honest plan prices and policies.
> These are not auto-implemented unless you approve; they are flagged as
> HUMAN_ACTION_REQUIRED per the task constraint.

---

## 8. What stays unchanged in CodeConClave

- The 2 static Payment Links (kept as fallback).
- The Razorpay webhook route and the entire 26H evidence pipeline.
- The security invariants: server-authoritative plan/amount, server-generated reference, trusted-provider-evidence-only activation, signature validation, idempotency, replay protection, anti-self-activation, tenant isolation, audit log.
- The Gmail rail remains **secondary / reconciliation** only.
- No source code needs to change to enable the capability — the feature is already implemented and gated on the presence of credentials.

---

## 9. What OpenCode will do AFTER capability approval (for context only — no actions this task)

1. Add Live `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` (and recommended `RAZORPAY_WEBHOOK_SECRET` + `RAZORPAY_WEBHOOK_ENABLED=true`) to the backend service env (Railway).
2. Ensure `RAZORPAY_MODE` is set so intents auto-create per-intent dynamic links.
3. (If webhook) configure the Razorpay webhook to `https://backend-production-95faa.up.railway.app/api/v1/payments/webhook/razorpay` with the matching secret, subscribe to `payment.captured` / `payment_link.paid`.
4. Run the existing test suite + typecheck/build, then deploy only with explicit approval.
5. Optionally run a **sandboxed/test-mode smoke test** (no real money) — not a production payment.

---

## 10. Final response block

See the final answer message for the templated summary.

---

*End of document. No secrets included. No deployment performed. No real payment performed.*
