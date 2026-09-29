# FINAL GOOGLE APPS SCRIPT ZERO-ADMIN AUDIT

> **Audit conducted against source + live backend. No secrets printed. No
> deployment performed. No real payment performed. No source modified.**
>
> **Scope question:** Can the CURRENT Google Apps Script watchdog + CURRENT
> static Razorpay Payment Links provide secure ZERO-ADMIN automatic payment
> activation using ONLY Razorpay Payment Links + Gmail (no API, no webhook,
> no admin)?

**HEADLINE VERDICT: CURRENT_GMAIL_WATCHDOG_ZERO_ADMIN = IMPOSSIBLE**
**NO_API_NO_WEBHOOK_NO_ADMIN = IMPOSSIBLE**

Two independent, fatal blockers make this impossible, not merely blocked:

1. **USER CORRELATION is impossible with static Payment Links** — the static
   links (`rzp.io/rzp/sAgHIpxS`, `rzp.io/rzp/3ioXlCxd`) produce confirmation
   emails carrying **no per-user codeconclave reference**. The entire
   gmail-claim rail (and the backend `gmail` evidence source) is
   **binding-required**: it refuses to act unless a server-issued
   `CCPRO-XXXXXX`/`CCTEAM-XXXXXX` reference is present. Absent a reference,
   the backend throws `reference_required`, so it can never know which user A
   or user B paid. The watchdog is a **transport**, not a **correlation
   oracle** — it cannot invent a mapping that the payment link itself does not
   carry.

2. **The designed flow is NOT automatic** — even in the best case where a
   reference exists (a path that requires per-intent dynamic links, which this
   current setup does not have), the gmail-claim rail requires the **customer
   to click a one-time emailed claim link** (`POST /activate`) to complete
   activation. That is a **user action after payment**, contradicting the
   requirement of AUTOMATIC USER UNLOCK / NO MANUAL REVIEW / zero action after
   payment. Without a click, nothing activates.

Additionally, the **deployed backend does not yet serve this rail** — live
checks return `403 csrf_mismatch` (the CSRF exemption for gmail-claim exists in
local source `middleware/csrf.ts` but is **not in the deployed build**).

---

## 1. What the current setup is

### Provider access actually available (per the operator)
| Capability | Owned? |
|---|---|
| Razorpay Payment Links (static) | ✅ |
| Google Apps Script Gmail Payment Watchdog | ✅ (running) |
| Gmail (controlled mailbox) | ✅ |
| CodeConClave backend | ✅ |
| Razorpay API keys | ❌ |
| Razorpay webhooks | ❌ |
| Razorpay website/app approval | ❌ |

### Google Apps Script watchdog (per operator + documented contract)
- Project: `CodeConClave Payment Watchdog`; time-driven trigger **every 1
  minute**, `function = myFunction`.
- Script properties: `CODECONCLAVE_BACKEND_URL`,
  `GMAIL_APPS_SCRIPT_SHARED_SECRET`, `WATCHDOG_ENABLED=true`, `LOG_LEVEL=INFO`.
- Behavior (documented): scan incoming Razorpay emails → check
  DKIM=pass/SPF=pass/DMARC=pass + `from: razorpay.com` → extract paymentId /
  amount / payerEmail / reference / plan / status → `Utilities.computeHmacSha256
  Signature` over `timestamp:JSON.stringify(payload)` using the shared secret →
  `POST <CODECONCLAVE_BACKEND_URL>/api/v1/payments/gmail-claim/request`.
- The `.gs` source is NOT in this repo (it lives only in the cloud Apps Script
  project), so parsing details are audited from the authoritative backend
  contract it must satisfy.

---

## 2. Backend gmail-claim rail (the receiving end) — audited from source

Source files audited:
- `backend/src/modules/payments/gmail-claim-routes.ts`
- `backend/src/modules/payments/gmail-claim.ts`
- `backend/src/modules/payments/pipeline.ts`
- `backend/src/modules/payments/evidence.ts`
- `backend/src/app.ts`, `backend/src/middleware/csrf.ts`, `backend/src/config/env.ts`
- `database/migrations/0057_gmail_claim_rail.sql`

### Endpoints
- `POST /api/v1/payments/gmail-claim/request` — Apps Script → backend.
  Body `{ payload: {paymentId, amount, plan, payerEmail, paidAt, reference},
  timestamp, signature }`.
- `POST /api/v1/payments/gmail-claim/activate` — payer clicks the emailed link.

### Verified security controls (source)
| Control | Result |
|---|---|
| HMAC-SHA256 over `timestamp:JSON.stringify(payload)`, `timingSafeEqual` | ✅ PASS |
| Timestamp replay window (default 300s) | ✅ PASS |
| Dedup by provider `paymentId` (`isDuplicatePayment`) | ✅ PASS |
| Plan whitelist (`pro`/`team`) | ✅ PASS |
| Amount == `PLAN_PRICES_INR` (server-authoritative ₹999/₹4999) | ✅ PASS |
| Intent resolved by server-issued `reference` (never email/amount/id alone) | ✅ PASS |
| One-time claim token (SHA-256 hashed, 24h TTL) | ✅ PASS |
| Exactly-once race guard (`UPDATE ... WHERE status='PENDING'`) | ✅ PASS |
| Activation via shared `activateEntitlement()` (no bypass) | ✅ PASS |
| Audit on every path | ✅ PASS |

### HMAC trust classification
The gmail-claim rail is a **separate, explicitly HMAC-authenticated flow**; it
does NOT feed the 26H `pipeline.ts` `gmail` evidence source scoring. It is
trusted (can reach ACTIVE) **only** when ALL of signature + timestamp + plan +
amount + reference + dedup pass. Unauthenticated/forged/bad-secret → `401`.

---

## 3. USER CORRELATION — the decisive blocker

The rail binds a payment to a user **exclusively** via
`payload.reference` → `findIntentByReference(reference)` →
`payment_intents` row → **exact `owner_id`**.

- `gmail-claim.ts:262` — if `reference` is empty → `400 reference_required`.
- `gmail-claim.ts:120-136` — reference must equal a server-issued
  `payment_intents.reference` (`CCPRO-XXXXXX` / `CCTEAM-XXXXXX`).

The trust hierarchy is: **payment id = dedup key, amount = validation, payer
email = NOT trusted for identity, reference = the ONLY user-binding key.**

### Static-link analysis (4. STATIC LINKS)
| Question | Answer |
|---|---|
| Do the static links carry a per-user `CCPRO/CCTEAM` reference? | **NO** — a Dashboard static payment link is a single shared link; it has no per-customer custom `reference_id`. Every payer of the same link yields a payment id unique to them, but **no** user–intent reference. |
| Can User A and User B both pay the same static link and the backend tell which intent/user paid? | **NO.** The email has no codeconclave reference; `payload.reference` is empty → the rail refuses (`reference_required`). paymentId+amount+email are deliberately NOT trusted for identity. |
| Does the Razorpay email contain an order/receipt/link id that the rails use for correlation? | The email may contain a payment id / order id / link id, but **none of the CodeConClave rails correlate on those** — they correlate ONLY on the codeconclave `reference`, which static links do not carry. |
| **STATIC_LINK_ZERO_ADMIN** | **IMPOSSIBLE** |

### 5. Does the watchdog create correlation? (5. GOOGLE APPS SCRIPT DOES NOT CREATE CORRELATION)
**NO.** The Apps Script merely **transports** whatever it extracts from the
email. It does NOT have (and cannot have) a trustworthy mapping to a
CodeConClave intent. It cannot synthesize a reference the email does not
contain. It is a relaying bridge, not an identity oracle. Do not mistake
`paymentId + amount + email` for an intent reference — the backend explicitly
treats those as non-identity.

> The ONLY way a per-user reference materializes in a Razorpay email is by
> creating **per-intent dynamic Payment Links via the Razorpay API** (each link
> with a unique `reference_id` + `notes`). That capability is NOT available in
> the current setup (no API keys / no website approval). The existing
> `createRazorpayPaymentLinkForIntent` in `service.ts` already supports this,
> but it is gated on real API credentials.

---

## 6. Backend ingestion audit (6. BACKEND INGESTION)

Verified in source (`gmail-claim.ts` `requestGmailClaim`), in order:
1. HMAC signature → `401 invalid_signature` (fail).
2. Timestamp tolerance → `400 timestamp_invalid` (fail).
3. Dedup by paymentId → returns duplicate (idempotent).
4. Plan whitelist → `400 invalid_plan`.
5. Amount vs `PLAN_PRICES_INR` → `400 amount_mismatch`.
6. Reference required + intent found (owner-binding) → `400 reference_required`
   / `404 not_found`.
7. Intent must not already be ACTIVE/GRACE.
8. Valid payer email → create one-time claim token → email claim link.
   → `200 status:'pending'`.

Activation (`activateGmailClaim`) requires the **customer to click the emailed
link** → token hash match → expiry/single-use → `activateEntitlement(...)` →
entitlement ACTIVE. **Plan + amount + reference are all validated; idempotency
and replay protection are present.** The security rails are sound.

---

## 7. ZERO-ADMIN TESTABILITY (7.)

Scenario: User A → chooses Pro → pays ₹999 via static link → Razorpay email →
Apps Script detects → backend identifies User A → verifies ₹999 → ACTIVE.

- **Backend identifies User A?** NO. The email from the shared static link has
  **no `CCPRO-XXXXXX` reference** → `reference_required`, no intent binding.
- **Result: NO activation, no claim — the exact opposite of the desired path.**
  The requirement of identifying a specific user from a shared static-link
  payment **cannot be proven** because no trusted correlation field exists.

Why: correlation requires a **cryptographically/server-authoritative**
per-user reference, which ONLY per-intent API-created links provide.

---

## 8. SECURITY ATTACK TESTS (logic-only, from source)

| Attack | Must fail? | Result (source) |
|---|---|---|
| Fake payment ID | ✅ | Dedup only; no identity granted. Not trusted → cannot activate alone. |
| Fake amount | ✅ | `amount != PLAN_PRICES_INR[plan]` → `400 amount_mismatch`. |
| Fake reference | ✅ | Reference must match a real `payment_intents.reference` → `404`. |
| Fake payer email | ✅ | Email not trusted for identity; must still be a syntactically valid address for token email. |
| Fake HMAC | ✅ | `timingSafeEqual` mismatch → `401 invalid_signature`, audited. |
| Replayed watchdog event | ✅ | Signed timestamp outside 300s window → `400 timestamp_invalid`. |
| Duplicate Gmail message | ✅ | Dedup by `paymentId` → `already_processed` (idempotent). |
| Wrong plan | ✅ | `invalid_plan` / `amount_mismatch`. |
| Wrong amount | ✅ | `amount_mismatch` against server price. |
| Payment for another user | ✅ | Claim bound to `intent.owner_id`; token single-use + hashed; cross-tenant owner check. |

**Security posture of the rail is sound — this is NOT where it fails.** It fails
on correlation availability (static links) and on automation completeness
(claims require a click).

---

## 9. WATCHDOG RELIABILITY

| Aspect | Assessment (by design/contract) |
|---|---|
| 1-minute trigger | Present; a temporary miss is caught on the next 1-min sweep. |
| Duplicate handling | `paymentId` dedup — idempotent redelivery. ✅ |
| Delayed email handling | New email detected on a later sweep creates the claim then. No data loss. |
| Missing email handling | Nothing posted → no claim → intent stays PENDING (safe, no false activation). ✅ |
| Gmail API quota failure | Apps Script `GmailApp.search` can throw on quota; watchdog should catch and retry next cycle (no false activation). |
| Retry behavior | Time-driven retrigger; no permanent-state corruption. |
| Backend outage | POST fails → the claim simply isn't created → wait until backend is back → retry. Safe PENDING. ✅ |
| Event replay protection | Timestamp window + `paymentId` dedup. ✅ |

Temporary Gmail/backend failure yields a **safe PENDING** (no wrongful
activation), not an incorrect ACTIVE. Reliability for *not over-activating* is
good; the problem is it **cannot activate at all** without a reference.

---

## 10. CURRENT DEPLOYED STATE (10.)

Live checks (no deployment, no config change):
- `POST /api/v1/payments/gmail-claim/request` → **`403 csrf_mismatch`**
- `POST /api/v1/payments/gmail-claim/activate` → **`403 csrf_mismatch`**

Interpretation:
- The routes are **reachable** (not 401 auth-shadowed) ⇒ the mounting fix IS
  partially live.
- But CSRF is **not exempted** ⇒ the deployed build does **not** include the
  gmail-claim CSRF exemption in `middleware/csrf.ts` ⇒ **the deployed backend
  cannot currently accept Apps Script POSTs** (the Apps Script has no browser
  cookie/CSRF token). This is the expected consequence of the **frozen,
  not-deployed** state. The full zero-admin rail is **local-only, not live**.

---

## 11. FINAL DECISION

Compare the options:

- **A = Gmail Apps Script watchdog + current static Payment Links**
  → **IMPOSSIBLE.** No per-user reference in static-link emails (correlation
  fails) AND the designed rail needs a claim-click (not automatic).
- **B = Razorpay API + unique per-intent Payment Links**
  → POSSIBLE (needs API keys + website approval). Per-intent links carry a
  unique `reference_id` → correlation succeeds; existing
  `createRazorpayPaymentLinkForIntent` supports it; `razorpay_api` evidence is
  a TRUSTED source.
- **C = Signed Razorpay webhook + unique per-intent Payment Links**
  → POSSIBLE (needs webhook + per-intent links). `razorpay_webhook` evidence is
  TRUSTED; route already live (returns 404 "Webhook not configured" until
  secret set).
- **D = API + signed webhook + Gmail secondary**
  → POSSIBLE & the **preferred** architecture (fully redundant, instant,
  fully trusted). All rails already implemented.
- **E = Current Gmail watchdog + some other EXISTING trusted correlation
  mechanism**
  → **NOT POSSIBLE** with existing mechanisms. The `gmail` evidence source also
  requires an exact reference in the email (strict `ref === reference`), which
  static links lack; no existing rail correlates on paymentId/amount/email.

**CURRENT_GMAIL_WATCHDOG_ZERO_ADMIN = IMPOSSIBLE**
**NO_API_NO_WEBHOOK_NO_ADMIN = IMPOSSIBLE**

**FINAL_RECOMMENDATION = WAIT_FOR_RAZORPAY_CAPABILITY**

Do NOT invent a workaround. The only secure path to zero-admin is the Razorpay
API (+ optionally webhook) with per-intent dynamic Payment Links — exactly as
documented in `docs/FINAL_RAZORPAY_ZERO_ADMIN_ACCESS_PLAN.md`.

---

## 12. NO REAL PAYMENT

₹999 / ₹4999 were NOT spent. No payment was simulated. No entitlement was
manually set ACTIVE. No deployment was performed. No secrets were exposed.

---

## 13. Gap summary (why the watchdog cannot meet the requirement)

| Requirement | Met? | Reason |
|---|---|---|
| ZERO ADMIN ACTION after payment | Partially — the rail needs no admin, BUT the customer must click a claim link (user action). | Not automatic. |
| AUTOMATIC USER UNLOCK | ❌ | Requires claim-link click; and with static links never even reached (no reference). |
| NO MANUAL REVIEW for normal successful payment | ❌ in practice | Cannot identify the user at all from a static-link email; the flow never produces a claim. |
| Secure correlation to exact user | ❌ | No per-user reference in static-link confirmation emails; rails refuse to act without one. |
| Security controls (HMAC, replay, amount, plan, dedup, ownership) | ✅ | Implemented and sound — but gated behind the missing correlation. |

**Bottom line:** The watchdog is a well-built, secure transport, but with ONLY
static Payment Links it is **IMPOSSIBLE** to deliver zero-admin activation. The
requirement is only achievable by obtaining the Razorpay **API capability**
(and, ideally, the signed webhook) with **per-intent dynamic Payment Links**.
Wait for that capability; do not build an insecure workaround.

---

*End of audit. No secrets. No deployment. No real payment.*
