# PAYMENT LINK-POOL FEASIBILITY ANALYSIS

## STEP 1 — RAZORPAY CAPABILITY AUDIT

### Payment Link reference_id Semantics
- **Unique per link**: "Must be a unique number for each Payment Link" (Razorpay docs)
- **Max 40 characters**
- **Set at creation time** (can be updated via PATCH API on links in "created" or "partially_paid" state)
- **Returned in callback**: `razorpay_payment_link_reference_id` parameter
- **Returned in webhook**: `payload.payment_link.entity.reference_id`

### Payment Link Reuse Behavior
- **Official FAQ**: "No, you can only accept payments from a single customer using a Payment Link"
- **Blog post**: "reused multiple times" (contradicts FAQ)
- **Practical interpretation**: Each link is for ONE customer. Multiple partial payments by the same customer are possible. Different customers need different links.
- **Impact on pool**: Pre-creating 100 links = capacity for 100 unique customers

### callback_url Parameters
- **Set at creation time** (can be updated via PATCH API)
- **Browser redirect after payment** (NOT a server webhook)
- **Parameters received**: `razorpay_payment_id`, `razorpay_payment_link_id`, `razorpay_payment_link_reference_id`, `razorpay_payment_link_status`, `razorpay_signature`
- **Signature verification**: HMAC-SHA256 using API secret (NOT webhook secret)
- **Method**: GET only (`callback_method: "get"`)
- **Unique per link**: YES — each link can have a different callback_url

### callback_url vs Webhook — CRITICAL DISTINCTION

| Aspect | callback_url | webhook |
|--------|-------------|---------|
| Trigger | Browser redirect after payment | Razorpay server-to-server |
| Signature secret | API secret (`key_secret`) | Webhook secret (`webhook_secret`) |
| Reliability | Requires browser open | Always-on (server-to-server) |
| Proof of payment | Weak (redirect, can be manipulated) | Strong (server-to-server) |
| Unique per link | YES (different URL per link) | NO (one URL for all links) |
| Fields | 5 fields (payment_id, link_id, reference_id, status, signature) | Full event payload |

### Whether Pre-Created Dashboard Links Can Have Fixed callback_url
- **Dashboard creation**: The dashboard UI does NOT expose callback_url field
- **API creation**: callback_url is a parameter at creation time
- **Update API**: callback_url can be added/updated via PATCH on links in "created" or "partially_paid" state
- **Conclusion**: Pre-created dashboard links can have callback_url added via the Update API

### Whether callback URL Can Uniquely Distinguish a Pre-Created Link
- **YES**: Each link can have a unique callback_url (e.g., `/cb/001`, `/cb/002`, etc.)
- **The callback_url path identifies the link**: The path segment (e.g., `001`) maps to the specific link
- **This is the KEY insight**: The callback URL is the ONLY way to distinguish pre-created links without the Razorpay API

### Whether callback Data Proves Payer Identity
- **NO**: The callback data proves which link was used, not who paid
- **Payer email**: Customer-entered, NOT provider-authenticated
- **Payer identity**: NOT proven by callback data

### Whether Customer Email/Phone Is Provider-Authenticated
- **NO**: Customer-entered fields in the Payment Link creation
- **NOT cryptographic identity proof**

### Whether Payment Links Support International Payments
- **Subject to account activation/eligibility**
- **Not guaranteed for all merchants**

---

## STEP 2 — POOL CORRELATION MODEL

### Model:
```
User A
→ authenticated CodeConClave session
→ assigned LINK 047
→ intent A bound to LINK 047
→ user pays LINK 047
→ browser redirects to /cb/047
→ callback carries reference_id: CCP-POOL-047
→ system maps: /cb/047 → LINK 047 → intent A → user A
```

### What Is Actually Proven:

| Statement | Strength | Evidence |
|-----------|----------|----------|
| LINK 047 → Intent A | **STRONG** | Unique callback path maps to unique link, which maps to unique intent |
| Intent A → User A | **STRONG** | Server-authoritative at creation (owner_id = userId) |
| LINK 047 was paid | **MODERATE** | callback_url is a browser redirect, not proof of payment |
| User A was the payer | **WEAK** | Anyone with the link could have paid |
| Payer email matches User A | **WEAK** | Customer-entered, not provider-authenticated |

### Critical Distinction:
- **LINK 047 → Intent A**: STRONG (cryptographic via reference_id + callback path)
- **LINK 047 → User A was the payer**: WEAK (no cryptographic binding)

---

## STEP 3 — ATTACK THE POOL

### Attack Scenario:
```
A. User A gets Link 047 (assigned by CodeConClave)
B. User A copies Link 047 URL to User B
C. User B opens Link 047 and pays
D. Browser redirects to /cb/047
E. System sees Intent A assigned to Link 047
```

### What the System Knows:
- Intent A was assigned to Link 047
- Link 047 was used (callback received)
- Intent A is owned by User A

### What the System Does NOT Know:
- Whether A paid for themselves
- Whether B paid as a gift for A
- Whether B paid intending to receive B's account
- Whether B obtained the link directly from A

### Entitlement Result:
- System activates Intent A → User A gets PRO
- User B paid but User A receives the entitlement
- **This is correct behavior IF POLICY B (gift payment) is acceptable**
- **This is incorrect behavior IF POLICY A (self-payer only) is required**

### Collusion Risk:
- User A pays once, gets PRO
- User A shares link with User B
- User B pays (gift for A) → A gets PRO again (idempotent, no double activation)
- User B cannot get PRO for themselves through this path

---

## STEP 4 — HEARTBEAT AUDIT

| Signal | Classification | Reason |
|--------|---------------|--------|
| Heartbeat | **WEAK_SIGNAL** | Browser presence, not cryptographic proof |
| Session cookie | **WEAK_SIGNAL** | Authentication, not payment proof |
| IP address | **WEAK_SIGNAL** | Network location, not identity |
| Browser presence | **WEAK_SIGNAL** | Client-side, not server-verifiable |
| Timing | **WEAK_SIGNAL** | Correlation, not proof |

**Do NOT allow weak signals to become VERIFIED payment proof.**

---

## STEP 5 — "MOST RECENT" AUDIT

### Scenario:
```
Intent A created at T1, assigned Link 047
Intent B created at T2, assigned Link 047 (after A expires)
Late callback from A arrives at T3
```

### If "Most Recent" Is Used:
- System sees callback at /cb/047
- System looks up "most recent" intent for Link 047 → Intent B
- Late payment from A activates Intent B → **WRONG USER GETS ENTITLEMENT**

### Required:
- **FAIL CLOSED**: Late callback on expired intent → rejected
- **No "most recent" guessing**: Each callback must match the exact intent it was assigned to

### **MOST_RECENT_AS_AUTHORITY = FORBIDDEN**

---

## STEP 6 — CONCURRENCY

### Scenario:
```
Two users, one available link, simultaneous checkout creation
```

### Required Guarantees:
1. **Atomic assignment**: No double assignment of the same link
2. **No race**: Concurrent requests must not both get the same link
3. **No stale lock**: Lock must be released on timeout
4. **No expired-link reuse**: Expired links must not be reassigned while callback is pending
5. **No orphan callback mis-assignment**: Callback from old assignment must not activate new intent

### Implementation:
- Use `SELECT ... FOR UPDATE` or atomic `UPDATE ... WHERE status = 'available' RETURNING *`
- Use database transaction isolation level SERIALIZABLE or READ COMMITTED with row-level locking
- Link status: AVAILABLE → ASSIGNED → USED → EXPIRED
- Intent TTL must be shorter than link reassignment window

### **CONCURRENCY = SOLVABLE with proper locking**

---

## STEP 7 — TTL / CALLBACK RACE

### Scenario:
```
Intent A assigned Link 047, expires at T1
Link 047 becomes available
Intent B assigned Link 047 at T2
Late callback from A arrives at T3 (T3 > T2)
```

### Required:
- A's late callback must NOT activate B's intent
- System must match callback to the EXACT intent it was assigned to

### Solution:
- Callback carries reference_id (e.g., CCP-POOL-047)
- System looks up intent by reference_id → finds Intent A (expired)
- Intent A is expired → reject (fail-closed)
- Intent B has a different reference_id (e.g., CCP-POOL-047-B) → no confusion

### **TTL_PROTECTION = SOLVABLE with reference-based matching**

---

## STEP 8 — PAYMENT GIFT POLICY

### Policy A: Only the authenticated account that initiates checkout may receive entitlement
- **Requirement**: Payer must be the same as the account owner
- **Problem**: Payer identity cannot be proven with static links
- **Result**: Exact payer-to-user correlation remains impossible

### Policy B: Anyone may pay for another authenticated CodeConClave account
- **Requirement**: Payment binds to the INTENT, not the payer
- **Result**: Link assignment is sufficient to bind entitlement to the intended recipient
- **Risk**: Collusion (A shares link, B pays, A gets PRO)

### Recommendation:
- **Policy B is the ONLY feasible option with static links**
- **Policy A requires per-intent API-created links with cryptographic binding**

---

## STEP 9 — GMAIL RAIL

### What Gmail Evidence Provides:
- **payment_id**: Razorpay payment ID (extracted from email)
- **amount**: Payment amount (extracted from email)
- **reference**: Server-issued reference (extracted from email)
- **customer-entered email**: Payer email (from email header)

### What Gmail Evidence Does NOT Provide:
- **Cryptographic proof of payer identity**: Email is customer-entered, not provider-authenticated
- **Proof that the payer is the account owner**: Anyone with the email address could have paid

### Gmail Role:
- **Evidence and reconciliation**, not identity proof
- **Supplementary signal**, not primary correlation

---

## STEP 10 — ZERO-ADMIN DEFINITION

| Term | Definition | Status |
|------|-----------|--------|
| ZERO_ADMIN | No administrator involved in payment processing | YES |
| ZERO_CLICK | No user action required after payment | NO (claim click required) |
| FULLY_AUTOMATIC | Payment automatically activates entitlement without user action | PARTIAL (webhook auto-activates; claim requires click) |
| AUTOMATIC | System processes payment without human intervention | YES (when webhook configured) |

### Do Not Conflate:
- ZERO_ADMIN ≠ ZERO_CLICK
- ZERO_ADMIN ≠ FULLY_AUTOMATIC
- AUTOMATIC ≠ ALWAYS_ON

---

## STEP 11 — 24/7 ANALYSIS

### Components:
| Component | Automatic | Always-On | Notes |
|-----------|----------|-----------|-------|
| Callback processing | YES | REQUIRES BROWSER | Browser redirect, not server-to-server |
| Watchdog sweep | YES | REQUIRES SERVICE | Runs when service is running |
| Webhook processing | YES | YES (server-to-server) | Independent of browser |
| Gmail evidence | YES | REQUIRES OAUTH | Periodic Gmail API polling |
| Restart recovery | YES | REQUIRES HOSTING | In-memory watermarks reset |

### **24X7_AUTOMATION = PARTIAL (depends on webhook availability)**

---

## STEP 12 — SAFE POOL DECISION

### OPTION A: Current shared static link
| Aspect | Assessment |
|--------|-----------|
| PAYMENT_AUTHENTICITY | WEAK (no signature verification) |
| PAYMENT_LINK_CORRELATION | NONE (shared link) |
| INTENT_CORRELATION | IMPOSSIBLE |
| USER_CORRELATION | IMPOSSIBLE |
| AUTOMATION | LOW |
| ADMIN_REQUIRED | NO |
| API_REQUIRED | NO |
| WEBHOOK_REQUIRED | NO |
| SECURITY | LOW |
| CONCURRENCY_RISK | LOW (single link) |
| LATE_CALLBACK_RISK | LOW (no correlation to break) |

### OPTION B: 100+ pre-created static links with unique callback paths
| Aspect | Assessment |
|--------|-----------|
| PAYMENT_AUTHENTICITY | MODERATE (callback signature verification) |
| PAYMENT_LINK_CORRELATION | STRONG (unique callback path) |
| INTENT_CORRELATION | STRONG (reference_id + callback path) |
| USER_CORRELATION | MODERATE (intent → user binding) |
| AUTOMATION | MODERATE |
| ADMIN_REQUIRED | NO |
| API_REQUIRED | NO (dashboard creation + API update for callback) |
| WEBHOOK_REQUIRED | NO (but recommended for payment proof) |
| SECURITY | MODERATE |
| CONCURRENCY_RISK | MODERATE (requires atomic assignment) |
| LATE_CALLBACK_RISK | MODERATE (requires TTL protection) |

### OPTION C: API-created per-intent links with unique reference
| Aspect | Assessment |
|--------|-----------|
| PAYMENT_AUTHENTICITY | STRONG (webhook signature) |
| PAYMENT_LINK_CORRELATION | STRONG (unique link per intent) |
| INTENT_CORRELATION | STRONG (reference_id) |
| USER_CORRELATION | STRONG (cryptographic binding) |
| AUTOMATION | HIGH |
| ADMIN_REQUIRED | NO |
| API_REQUIRED | YES |
| WEBHOOK_REQUIRED | YES |
| SECURITY | HIGH |
| CONCURRENCY_RISK | LOW (per-intent links) |
| LATE_CALLBACK_RISK | LOW (per-intent links) |

### OPTION D: API-created per-intent links + webhook
| Aspect | Assessment |
|--------|-----------|
| PAYMENT_AUTHENTICITY | STRONGEST |
| PAYMENT_LINK_CORRELATION | STRONGEST |
| INTENT_CORRELATION | STRONGEST |
| USER_CORRELATION | STRONGEST |
| AUTOMATION | HIGHEST |
| ADMIN_REQUIRED | NO |
| API_REQUIRED | YES |
| WEBHOOK_REQUIRED | YES |
| SECURITY | HIGHEST |
| CONCURRENCY_RISK | LOWEST |
| LATE_CALLBACK_RISK | LOWEST |

---

## STEP 13 — SAFE NO-MONEY TEST HARNESS

### Deterministic Tests Required:
1. **Atomic pool allocation**: Concurrent requests → no double assignment
2. **Link-to-intent binding**: Assign → pay → callback → activation
3. **Concurrent allocation**: Two users, one link, simultaneous checkout
4. **TTL expiration**: Intent expires → link becomes available
5. **Link reuse**: Link reassigned after intent expires
6. **Late callbacks**: Late callback on expired intent → rejected
7. **Duplicate callbacks**: Same callback twice → idempotent
8. **Wrong callback path**: Callback at wrong path → rejected
9. **Wrong reference**: Callback with wrong reference → rejected
10. **Cross-user attempt**: User B tries to use User A's link → activates A's intent
11. **Cross-workspace attempt**: Different workspace → rejected
12. **Copied payment link**: Link copied to another user → activates original intent
13. **Payment-for-another-user**: B pays for A → A gets entitlement (POLICY B)

---

## FEASIBILITY GATE

```
=== PAYMENT LINK-POOL FEASIBILITY GATE ===

STATIC_SHARED_LINK = INSECURE (no user correlation)
LINK_POOL = FEASIBLE WITH CONDITIONS (see below)
UNIQUE_CALLBACK_PATH = YES (each link can have unique callback_url)
PAYMENT_LINK_TO_INTENT = STRONG (reference_id + callback path)
INTENT_TO_USER = STRONG (server-authoritative at creation)
PAYER_IDENTITY = WEAK (customer-entered, not provider-authenticated)
PAYMENT_AUTHENTICITY = MODERATE (callback signature verification)
ENTITLEMENT_SECURITY = STRONG (applyDecision remains sole gate)

HEARTBEAT = WEAK_SIGNAL (not cryptographic proof)
SESSION_COOKIE = WEAK_SIGNAL (authentication, not payment proof)
IP_SIGNAL = WEAK_SIGNAL (network location, not identity)
TIME_SIGNAL = WEAK_SIGNAL (correlation, not proof)
MOST_RECENT_SIGNAL = FORBIDDEN (causes wrong-user activation)
GMAIL_SIGNAL = EVIDENCE_ONLY (reconciliation, not identity proof)

CONCURRENCY = SOLVABLE (atomic assignment with DB locking)
TTL_PROTECTION = SOLVABLE (reference-based matching, fail-closed)
LATE_CALLBACK_PROTECTION = SOLVABLE (reject on expired intent)
REPLAY_PROTECTION = SOLVABLE (idempotent processing)
EXACTLY_ONCE = EXISTING (applyDecision remains sole gate)

ZERO_ADMIN = YES
ZERO_CLICK = NO (claim click required for Gmail rail)
FULLY_AUTOMATIC = PARTIAL (webhook auto-activates; claim requires click)
24X7_AUTOMATION = PARTIAL (depends on webhook availability)

POLICY_A_SELF_PAYER_ONLY = IMPOSSIBLE with static links
POLICY_B_GIFT_PAYMENT = REQUIRED for pool design

OPTION_A = INSECURE (no correlation)
OPTION_B = CONDITIONAL (requires POLICY B, moderate security)
OPTION_C = STRONG (requires API, strong security)
OPTION_D = STRONGEST (requires API + webhook, highest security)

POOL_SOLUTION_STATUS = FEASIBLE_ONLY_WITH_POLICY_B

PRIMARY_MISSING_TRUST_SIGNAL = Payer identity proof (customer-entered email is not cryptographic)

EXACT_NEXT_ACTION = 
1. Decide POLICY A vs POLICY B
2. If POLICY B: implement pool with atomic assignment, TTL protection, fail-closed callbacks
3. If POLICY A: implement OPTION C (API-created per-intent links)

FEATURES_REMOVED = 0
NO_TESTS_WEAKENED = TRUE

REAL_PAYMENT = NOT_PERFORMED
PRODUCTION_DEPLOYMENT = NOT_EXECUTED
```

---

## CRITICAL FINDINGS

1. **The pool design IS feasible** but ONLY under POLICY B (gift payment allowed)
2. **The callback_url is the KEY differentiator** — it's the only way to distinguish pre-created links
3. **The callback_url is a BROWSER REDIRECT**, not a server webhook — requires browser open
4. **Payer identity CANNOT be proven** with static links — customer-entered email is not cryptographic
5. **The pool design improves correlation** but does NOT improve payer identity proof
6. **Concurrency and TTL race are solvable** with proper DB locking and reference-based matching
7. **"Most recent" MUST NOT be used** as entitlement authority — causes wrong-user activation
8. **Heartbeat, cookie, IP, timing are WEAK SIGNALS** — not cryptographic proof

## DO NOT IMPLEMENT

- Heartbeat-based automatic activation
- "Most recent wins" logic
- Time-gap guessing
- Weakened UNKNOWN → PENDING/REVIEW rule
- Payer identity claims based on weak signals

## SAFE IMPLEMENTATION CONDITIONS

If POLICY B is acceptable:
1. Implement atomic pool assignment with DB locking
2. Use unique callback_urls for link identification
3. Fail-closed on expired intents
4. Reject late callbacks on expired intents
5. Keep applyDecision as sole activation gate
6. Do NOT use heartbeat/cookie/IP/time as payment proof
7. Document that gift payments are allowed

If POLICY A is required:
1. Implement OPTION C (API-created per-intent links)
2. Cryptographic binding via reference_id
3. Webhook for server-to-server payment proof
4. No static link fallback for user correlation
