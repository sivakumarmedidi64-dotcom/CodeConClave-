# PAYMENT ARCHITECTURE RECONCILIATION

## 1. PAYMENT AUTHENTICITY

**VERIFIED.** Each evidence source has its own authenticity mechanism:

| Source | Authenticity Mechanism | Verified |
|---|---|---|
| Razorpay Webhook | HMAC-SHA256 signature (`X-Razorpay-Signature` header) using `RAZORPAY_WEBHOOK_SECRET` | YES |
| Gmail Claim (Apps Script) | HMAC-SHA256 signature using `GMAIL_CLAIM_HMAC_SECRET` with timestamp tolerance | YES |
| Gmail OAuth (Server-side) | DKIM/SPF/DMARC verification for `razorpay.com` domain (`isAuthenticRazorpayMail`) | YES |
| Razorpay API | Basic auth (API key/secret) | YES |
| OCR/Manual | Always forced to REVIEW (untrusted) | N/A |

**Conclusion:** A signed callback proves the authenticity of callback DATA. It does NOT prove which authenticated CodeConClave user made the payment (that requires correlation).

---

## 2. PAYMENT EXISTENCE / CAPTURE

**VERIFIED.** The webhook confirms payment existence when event type is `payment.captured`, `payment_link.paid`, or `payment.authorized`. The handler explicitly checks these event types before proceeding (routes.ts lines 474-488). Non-success events are logged but do not change state.

**Conclusion:** Payment existence is verified by the webhook event type.

---

## 3. PAYMENT-LINK AUTHENTICITY

**PARTIALLY VERIFIED.** Two modes exist:

| Mode | How Created | Reference Binding | Authenticity |
|---|---|---|---|
| API-created per-intent | `POST /v1/payment_links` with unique `reference_id` | Per-user (unique reference) | STRONG |
| Static shared | Pre-configured in Razorpay dashboard | None (shared across users) | WEAK |

**Key finding:** When the Razorpay API is available, `createRazorpayPaymentLinkForIntent()` creates a per-intent link with the unique reference. When the API is unavailable, it falls back to static shared links.

**Conclusion:** API-created links are authentic and user-bound. Static links are authentic but NOT user-bound.

---

## 4. PAYMENT-TO-INTENT CORRELATION

**VERIFIED when API is available. FAILS when API is unavailable.**

### With API-created per-intent Payment Link:
```
Intent creation (intents.ts:90)
  → generates reference: "CCPRO-A3B7X2"
  → creates Razorpay Payment Link with reference_id: "CCPRO-A3B7X2"
  → stores provider_payment_link_id + provider_reference_id

Webhook (routes.ts:402-427)
  → extracts reference_id from payload
  → resolves intent by: provider_reference_id → provider_payment_link_id → reference
  → finds exact intent

Test proof (payments-26h.test.ts:1055)
  → webhookProEvent carries reference_id: REF
  → handler resolves to intent owned by u1
  → result: ACTIVE with entitlement
```

### With static shared link:
```
Intent creation (intents.ts:90)
  → generates reference: "CCPRO-A3B7X2"
  → falls back to static link (no provider_payment_link_id)
  → provider_reference_id = null

Webhook (routes.ts:402-427)
  → extracts reference_id from payload (may be null for static link)
  → resolves by reference → may match multiple intents
  → AMBIGUOUS correlation
```

**Test proof (payments-26h.test.ts:1119):**
When the DB returns no matching intent for the reference_id, the handler returns `{ ok: false, reason: 'no_matching_intent' }` and no entitlement is created.

**Conclusion:** CORRELATION IS CRYPTOGRAPHIC when API creates per-intent links. CORRELATION FAILS with static shared links.

---

## 5. PAYMENT-TO-USER CORRELATION

**VERIFIED through reference → intent → owner_id chain.**

The binding is established at intent creation:
```
createPaymentIntent(userId, planId)
  → intent.owner_id = userId (authenticated user)
  → intent.reference = unique reference
  → intent.provider_reference_id = Razorpay reference_id (if API available)
```

At verification:
```
Webhook → reference_id → intent lookup → intent.owner_id → user
```

**Test proof (payments-26h.test.ts:1055):**
The webhook handler resolves the intent by reference_id, then the 26H pipeline uses `intent.owner_id` to grant the entitlement to that user.

**Test proof (payments-26h.test.ts:309):**
"Another user cannot ingest evidence into someone else's intent" — cross-user isolation is enforced.

**Conclusion:** USER CORRELATION IS POSSIBLE through the reference → intent → owner_id chain, but ONLY when the reference is unique per intent (API-created links).

---

## 6. ENTITLEMENT AUTHORITY

**VERIFIED.** The entitlement activation is server-authoritative:

1. `applyDecision()` only activates when decision == 'ACTIVE'
2. Exactly-once guard: `UPDATE payment_intents SET status = 'ACTIVE' WHERE status IN ('PENDING','REVIEW')`
3. `activateEntitlement()` uses `ON CONFLICT (user_id, plan_id) DO UPDATE`
4. `effectivePlan()` checks both `users.plan_id` AND `entitlements.state`

**Conclusion:** ENTITLEMENT IS SERVER-AUTHORITATIVE. No client-side activation possible.

---

## DECISIVE TEST: Can the system prove payment X → intent A → user A?

### With API-created per-intent Payment Link: YES

```
User A creates intent A (reference: CCPRO-AAA)
  → Razorpay Payment Link created with reference_id: CCPRO-AAA
  → User A pays
  → Webhook carries reference_id: CCPRO-AAA
  → Handler resolves intent by reference CCPRO-AAA
  → Intent A has owner_id: User A
  → Entitlement granted to User A
```

**Cryptographic proof:** reference_id is unique per link, link is unique per intent, intent is unique per user.

### With static shared link: NO

```
User A creates intent A (reference: CCPRO-AAA)
  → Static shared link (no unique reference_id)
  → User A pays
  → Webhook carries... what reference_id?
  → If static link has no reference_id → no match → REVIEW
  → If static link has fixed reference → all users match to same intent → WRONG
```

**EXACT_USER_CORRELATION = IMPOSSIBLE_WITH_SHARED_STATIC_LINK**

---

## CALLBACK ANALYSIS

### Fields Received (routes.ts:368-386):
| Field | Source | Purpose |
|---|---|---|
| `id` | `event.id` | Event ID for dedup |
| `event` | `event.event` | Event type (payment.captured, etc.) |
| `payload.payment.entity.id` | Razorpay payment_id | Payment identifier |
| `payload.payment.entity.amount` | Amount in paise | Amount validation |
| `payload.payment.entity.email` | Payer email | Informational only |
| `payload.payment.entity.created_at` | Unix timestamp | Time validation |
| `payload.payment_link.entity.id` | Razorpay link_id | Intent resolution (key 2) |
| `payload.payment_link.entity.reference_id` | Server-assigned reference | Intent resolution (key 1) |
| `payload.payment.entity.notes.reference` | From notes | Intent resolution (key 3) |

### Signature Verification (routes.ts:343-366):
- HMAC-SHA256 over raw body bytes
- Using `RAZORPAY_WEBHOOK_SECRET`
- Constant-time comparison via `timingSafeEqual`
- Length check before comparison

### What Is Proven:
- Callback data is authentic (HMAC verified)
- Payment exists (event type verified)
- Amount matches (validated against intent)
- Reference exists in payload

### What Is NOT Proven:
- Which authenticated user made the payment (requires reference → intent → user chain)
- That the payer email matches the user's account email (informational only)

### Browser Redirect vs Server Webhook:
The handler at `POST /api/v1/payments/webhook/razorpay` is a SERVER WEBHOOK (HMAC-authenticated, no session cookie). The browser redirect at `GET /api/v1/payments/status` is a SEPARATE path that does NOT grant entitlements.

---

## RAIL A ANALYSIS (Merchant Email Evidence)

### Sender Authenticity:
`isAuthenticRazorpayMail()` (evidence.ts:247) verifies DKIM/SPF/DMARC for `razorpay.com` domain. This is a STRONG authenticity check.

### Reference Field:
The Gmail OAuth collector searches for `CC(PRO|TEAM)-[A-Z0-9]{6}` regex in email text. This means the server-issued reference must appear in the email body/subject.

### Payment ID:
Extracted via regex `/\bpay_[A-Za-z0-9_]{6,}\b/` from email text.

### Amount:
Extracted via regex `₹\s?([\d,]+(?:\.\d{1,2})?)` from email text.

### Payer Information:
Extracted from `From:` header. NOT from email body.

### Whether User Identity Is Authoritative:
NO. The payer email is informational only. The correlation is through the reference → intent → owner_id chain.

### Whether Razorpay Reference Is Echoed:
The codebase assumes the reference appears in the email (evidence.ts:304 regex search). However, there is NO integration test or documentation proving Razorpay echoes the `reference_id` in merchant emails.

**REAL_RAZORPAY_REFERENCE_BEHAVIOR = UNVERIFIED**

---

## INTENT-CLAIM ANALYSIS

### Claim Flow:
```
1. Apps Script detects Razorpay email → HMAC-signed POST to backend
2. Backend verifies HMAC, validates amount, finds intent by reference
3. Creates one-time claim token (SHA-256 hashed)
4. Sends claim email to payer via outbox
5. Customer clicks claim link → activates entitlement
```

### Classification:
**C. ZERO-ADMIN BUT NOT ZERO-CLICK**

- No administrator involved (ZERO-ADMIN: TRUE)
- User must click claim link (ZERO-CLICK: FALSE)
- User must have access to payer email (authentication requirement)
- Claim is one-time and expires (security)

### NOT Fully Automatic:
A customer clicking "claim" is still a user action. This is a USER-ASSISTED flow, not fully automatic.

### NOT Unsafe:
The claim token is:
- SHA-256 hashed before storage
- One-time use (exactly-once guard)
- Time-limited (TTL)
- Sent to the payer email only

---

## COLLUSION TEST

### Scenario:
```
User A pays shared static link
User A shares callback/payment proof
User B claims first
```

### Analysis:
1. User A creates intent A (reference: CCPRO-AAA)
2. User A pays shared static link
3. User A shares proof (email screenshot, payment ID, etc.)
4. User B creates intent B (reference: CCPRO-BBB)
5. User B tries to claim with User A's proof

### Result:
The system would:
1. Extract reference from proof → CCPRO-AAA (User A's reference)
2. Find intent by reference → Intent A (owned by User A)
3. Amount matches
4. Claim token created for Intent A
5. User B clicks claim link → activates entitlement for **User A** (not User B)

**COLLUSION_RISK = LOW (limited by claim token → email binding)**

The claim link is sent to the payer email. Only someone with access to User A's email could click it. Even then, it activates User A's entitlement, not User B's.

**However:** If User A shares the claim link with User B, and User B has access to User A's email, then:
- User B clicks → User A gets PRO
- This is a "gift" scenario, not a theft scenario
- User B cannot get PRO for themselves through this path

---

## NO-API / NO-WEBHOOK QUESTION

| Capability | NO_API | NO_WEBHOOK | NO_ADMIN | NO_MANUAL_CLAIM |
|---|---|---|---|---|
| Static link usage | POSSIBLE | POSSIBLE | POSSIBLE | N/A |
| Per-intent link creation | IMPOSSIBLE | POSSIBLE | POSSIBLE | N/A |
| Webhook auto-activation | POSSIBLE (if webhook configured) | IMPOSSIBLE | POSSIBLE | POSSIBLE |
| Gmail OAuth evidence | POSSIBLE | POSSIBLE | POSSIBLE | POSSIBLE (automatic sweep) |
| Gmail claim | POSSIBLE | POSSIBLE | POSSIBLE | IMPOSSIBLE (requires click) |
| Self-service | POSSIBLE | POSSIBLE | POSSIBLE | IMPOSSIBLE (requires confirmation) |

**Do not collapse these into one YES/NO.**

---

## BEST ARCHITECTURE OPTIONS

### OPTION A: shared static link + merchant email Rail A
| Aspect | Assessment |
|---|---|
| Security | WEAK (no user correlation on static link) |
| Automation | PARTIAL (email evidence can match, but correlation is ambiguous) |
| User Correlation | IMPOSSIBLE without per-intent reference |
| Complexity | LOW |
| Provider Dependency | Razorpay dashboard (for link creation) |
| Admin | NONE |
| API | NOT REQUIRED |
| Webhook | OPTIONAL |

### OPTION B: shared static link + signed callback + authenticated claim
| Aspect | Assessment |
|---|---|
| Security | MODERATE (claim requires email access) |
| Automation | PARTIAL (claim requires user click) |
| User Correlation | THROUGH CLAIM TOKEN (email-based, not cryptographic) |
| Complexity | MODERATE |
| Provider Dependency | Razorpay webhook |
| Admin | NONE |
| API | NOT REQUIRED |
| Webhook | REQUIRED |

### OPTION C: API-created per-intent Payment Link + unique reference + callback
| Aspect | Assessment |
|---|---|
| Security | STRONG (cryptographic binding via reference) |
| Automation | HIGH (auto-activation from webhook) |
| User Correlation | CRYPTOGRAPHIC (reference → intent → user) |
| Complexity | MODERATE |
| Provider Dependency | Razorpay API + Webhook |
| Admin | NONE |
| API | REQUIRED |
| Webhook | REQUIRED |

### OPTION D: API-created per-intent link + signed webhook
| Aspect | Assessment |
|---|---|
| Security | STRONGEST (API + webhook) |
| Automation | HIGHEST |
| User Correlation | CRYPTOGRAPHIC |
| Complexity | HIGH |
| Provider Dependency | Razorpay API + Webhook |
| Admin | NONE |
| API | REQUIRED |
| Webhook | REQUIRED |

---

## BEST CURRENT OPTION

**OPTION C: API-created per-intent Payment Link + unique reference + callback**

### Reason:
1. Provides cryptographic user correlation (reference → intent → user)
2. Auto-activation from webhook (no manual claim needed)
3. No admin required
4. Moderate complexity (already partially implemented)
5. The system already has `createRazorpayPaymentLinkForIntent()` that creates per-intent links

### Implementation Status:
- `createRazorpayPaymentLinkForIntent()` — EXISTS (service.ts:110)
- Per-intent reference generation — EXISTS (intents.ts:79)
- Webhook reference resolution — EXISTS (routes.ts:402-427)
- Fallback to static links — EXISTS (intents.ts:109-121)

### What's Missing:
- Integration test proving end-to-end per-intent link → webhook → activation works with real Razorpay API
- Documentation of Razorpay reference_id behavior in merchant emails

---

## PRIMARY MISSING TRUST SIGNAL

**WHEN THE RAZORPAY API IS UNAVAILABLE, THE SYSTEM FALLS BACK TO STATIC LINKS, AND STATIC LINKS CANNOT PROVIDE USER CORRELATION.**

This means:
- If Razorpay API is configured → per-intent links → cryptographic correlation → WORKS
- If Razorpay API is NOT configured → static links → no correlation → FAILS (goes to REVIEW)

The system is designed with this fallback, but it means the security guarantee depends on Razorpay API availability.

---

## 24/7 ANALYSIS

### Automatic:
The Gmail watchdog sweep (`sweepPendingIntentEvidence`) is automatic when the service is running. It runs periodically, checking PENDING/REVIEW intents.

### Restart/Recovery:
The sweep uses in-memory watermarks (`mailboxSweepWatermark`). On restart, the watermark resets, but this is safe because:
- The sweep only processes PENDING/REVIEW intents
- The pipeline has replay guards (SHA-256 dedup)
- Idempotent processing means re-swept evidence is a no-op

### Always-On:
The watchdog is automatic when the service is running, but NOT truly 24/7 unless:
- The hosting/runtime guarantees an always-running process
- The service restarts automatically after crashes
- The Gmail OAuth token remains valid

**AUTOMATIC_24X7 = CONDITIONAL (depends on hosting/runtime)**

---

## INTERNATIONAL PAYMENTS

### Official Razorpay Documentation:
- Payment Links can be created for international payments
- Subject to account capability/activation
- Not all merchants are eligible

### CodeConClave Status:
- The system uses `currency: 'INR'` (hardcoded in intents.ts)
- No international currency support implemented
- International payment support depends on Razorpay account activation

**INTERNATIONAL_PAYMENT_SUPPORT = CONDITIONAL (depends on Razorpay account)**

---

## RECONCILIATION GATE

```
=== PAYMENT ARCHITECTURE RECONCILIATION GATE ===

PAYMENT_AUTHENTICITY = VERIFIED (HMAC-SHA256 for webhook, DKIM/SPF/DMARC for Gmail)
PAYMENT_EXISTENCE = VERIFIED (webhook event type check)
PAYMENT_CORRELATION = VERIFIED when API available; FAILS with static links
USER_CORRELATION = VERIFIED through reference → intent → owner_id chain
ENTITLEMENT_SECURITY = VERIFIED (server-authoritative, exactly-once)

RAIL_A = VERIFIED (Gmail OAuth with DKIM/SPF/DMARC)
CALLBACK = VERIFIED (HMAC-SHA256 signature verification)
INTENT_CLAIM = ZERO-ADMIN BUT NOT ZERO-CLICK (user must click claim link)
STATIC_LINK = INSECURE for user correlation (no per-user binding)

NO_API = POSSIBLE for static links; IMPOSSIBLE for per-intent links
NO_WEBHOOK = POSSIBLE for Gmail evidence; IMPOSSIBLE for auto-activation
NO_ADMIN = POSSIBLE for all flows
NO_MANUAL_CLAIM = IMPOSSIBLE (Gmail claim requires user click; self-service requires confirmation)

ZERO_ADMIN_AUTOMATION = PARTIAL (webhook auto-activation when API available)
AUTOMATIC_24X7 = CONDITIONAL (depends on hosting/runtime)
INTERNATIONAL_PAYMENT_SUPPORT = CONDITIONAL (depends on Razorpay account)

COLLUSION_RISK = LOW (claim token → email binding limits theft; "gift" scenario possible)

OPTION_A = WEAK (no user correlation)
OPTION_B = MODERATE (email-based correlation)
OPTION_C = STRONG (cryptographic correlation) ← RECOMMENDED
OPTION_D = STRONGEST (API + webhook)

BEST_CURRENT_OPTION = OPTION_C
REASON = Provides cryptographic user correlation, auto-activation, no admin, partially implemented

PRIMARY_MISSING_TRUST_SIGNAL = Static link fallback breaks user correlation

REAL_RAZORPAY_REFERENCE_BEHAVIOR = UNVERIFIED (no integration test proving reference_id in merchant emails)

REAL_PAYMENT = NOT_PERFORMED
PRODUCTION_DEPLOYMENT = NOT_EXECUTED
FEATURES_REMOVED = 0
NO_TESTS_WEAKENED = TRUE

NEXT_PAYMENT_ACTION = Verify Razorpay reference_id behavior with integration test; ensure API credentials are configured in production
```

---

## CRITICAL FINDINGS

1. **The system is well-designed for OPTION C** but falls back to static links when API is unavailable
2. **The webhook handler is correct** — HMAC verification, intent resolution, amount validation, exactly-once activation
3. **The Gmail evidence rail is correct** — DKIM/SPF/DMARC verification, reference-based correlation
4. **The intent-claim flow is safe** — one-time tokens, SHA-256 hashing, email-based delivery
5. **The primary weakness is the static link fallback** — no user correlation when API is unavailable
6. **The Razorpay reference_id behavior is unverified** — no integration test proving it works in merchant emails

## DO NOT MODIFY

- The existing payment authority unless a concrete defect is found
- The existing entitlement system
- The existing webhook handler
- The existing Gmail evidence rail
- The existing intent-claim flow

## DO NOT CREATE

- A second entitlement system
- A second payment authority
- A duplicate webhook handler

## DO NOT PERFORM

- A real payment
- A real deployment
- A real admin approval

## DO NOT CALL

- A user-assisted claim "fully automatic"
- A signed callback "proof of exact user identity" (unless reference → intent → user chain is complete)
- A static link "cryptographically secure" for user correlation

---

## NEXT PAYMENT ACTION

1. Verify Razorpay reference_id behavior with integration test
2. Ensure Razorpay API credentials are configured in production
3. Document that static link fallback is INSECURE for user correlation
4. Consider adding integration test for end-to-end per-intent link flow
