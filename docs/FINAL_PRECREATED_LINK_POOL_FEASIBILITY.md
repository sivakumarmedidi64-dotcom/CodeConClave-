# FINAL — PRE-CREATED UNIQUE RAZORPAY PAYMENT-LINK POOL FEASIBILITY

> **Scope:** Determine whether a pool of MANUALLY pre-created Razorpay Payment
> Links (Dashboard, NO API) can provide trusted
> PaymentLink/reference → exact CodeConClave intent → exact user, enabling
> zero-admin 24/7 automatic unlock with only Payment Links + Gmail + Apps
> Script + backend.
> **No deploy. No real payment. No source change. No secrets.** Honest
> UNKNOWN where not verified (per instruction).

---

## Verdict

**PRECREATED_LINK_POOL = NOT_VIABLE** (not provably viable today)

The core idea is structurally sound — a Dashboard-created Payment Link CAN carry
a unique `reference_id` — but the end-to-end correlation **cannot be verified or
relied upon** with the current evidence, and several concrete blockers exist. We
must NOT declare it viable on assumption. The one decisive unknown (does the
**merchant** confirmation email that lands in the watchdog's Gmail contain the
`plink_` id / `reference_id` in a reliably parseable form?) is **not
documented by Razorpay**, and the malicious-customer + ambiguous-link failure
modes are fatal.

---

## CRITICAL QUESTION 1 — Dashboard reference_id without API

**ANSWER: SUPPORTED.**

Official Razorpay docs ("Create a Standard Payment Link From Dashboard") confirm
the Dashboard's Standard Payment Link pop-up includes:
- **Reference Id (Optional): Provide a unique reference number for the link.** —
  must be **unique per Payment Link**, max **40 characters**.
- **Notes (Optional)** — internal title/description key-value pairs.
- **Customer Details (Optional)** — email + phone.
- Amount, currency, notify (email/SMS), expiry.

So a human using only the Dashboard CAN create links tagged `CCPRO-POOL-0001`,
`CCPRO-POOL-0002`, …, `CCTEAM-POOL-0001`, etc., each with its own amount
(₹999 / ₹4999), unique reference, and no API.

> **DASHBOARD_REFERENCE_ID = SUPPORTED**

---

## CRITICAL QUESTION 2 — Does the merchant confirmation email include the reference/link id?

**ANSWER: UNKNOWN (cannot be verified from documentation).**

What IS documented (in API objects / webhooks / callbacks / third-party
notification templates):
- Payment Link entity has an immutable `id` (`plink_…`, exactly 14 chars after
  prefix), `reference_id`, `order_id`, `short_url`, and `payments[]` populated
  after capture with `payment_id`.
- Callback/webhook carry `razorpay_payment_link_id`,
  `razorpay_payment_link_reference_id`, `razorpay_payment_id`,
  `razorpay_signature`.
- Payment receipts to **customers** can be emailed as a **PDF attachment**; "the
  details entered by the customer while making the payment also appear on the
  email body."
- Razorpay states **"Notifications: You receive notifications regarding activity
  on Payment Links via emails and webhook"** and payments are trackable on the
  **Dashboard** (Transactions → Payments).

What is NOT documented: the **exact body of the merchant's own notification
email** (the message that would land in the controlled Gmail mailbox the
watchdog reads). Nothing in the official docs confirms that this specific email
contains the `plink_` id or the custom `reference_id` in plain, parseable
text. The `{{reference_id}}`/`{{short_url}}` placeholders found are from a
**third-party (Raven) notification extension**, not the default merchant
confirmation email.

Per your explicit rule ("Do NOT assume … report UNKNOWN"), this is **UNKNOWN**.

> **REFERENCE_IN_MERCHANT_EMAIL = UNKNOWN**
> **LINK_ID_IN_MERCHANT_EMAIL = UNKNOWN**

---

## CRITICAL QUESTION 3 — Can the Gmail watchdog / backend extract that identifier?

**ANSWER: FAIL (as currently implemented) / UNKNOWN (for a new parser).**

Audited backend parsers only recognize the exact server-issued pattern
`CC(PRO|TEAM)-[A-Z0-9]{6}` (6 hex chars after the dash):
- `evidence.ts:305` `gmailSource()` — `/\bCC(PRO|TEAM)-[A-Z0-9]{6}\b/` and strict
  `ref === reference`.
- `evidence.ts:157` `parseOcrText()` — same pattern.
- `gmail-claim.ts` — resolves via `payload.reference` to a
  `payment_intents.reference`.

Consequences:
1. The proposed pool refs `CCPRO-POOL-0001` / `CCTEAM-POOL-0001` do **NOT**
   match the existing `[A-Z0-9]{6}` pattern (they contain `POOL` and 4 digits),
   so even today's backend would not extract them. A schema change would be
   needed.
2. The `.gs` Apps Script source is not stored in this repo and cannot be
   inspected here; its current reference/parsing behavior is unverified.
3. There is no implemented logic to extract a `plink_…` id or an arbitrary
   `reference_id` from a merchant email body. Even if the email contains those
   tokens, extracting and binding them requires **new parser + new matching
   code** (not present).

So: **GMAIL_EXTRACTION = FAIL** for the current system; it would become
**UNKNOWN/feasible** only after (a) confirming the email really carries the
identifier and (b) writing new extraction+binding code — both out of the current
constraint ("Do NOT modify source yet").

---

## CRITICAL QUESTION 4 — Can CodeConClave safely pre-bind a unique link → intent → user before payment?

**ANSWER: Yes, ONLY on the codeconclave side, and ONLY if the reference is
server-issued and registered — but the full loop is blocked by Q2/Q3.**

The safe pattern on CodeConClave's side:
- Create a `payment_intent` per user with a **server-authoritative reference**
  (e.g. `CCPRO-XXXXXX`).
- Assign it a **pre-created pool link** and record that the pool link's
  `reference_id` == the intent's reference in the DB.
- The exact user is the intent's `owner_id` (server-derived, tenant-isolated).
- When trusted evidence arrives carrying that reference, it resolves to that one
  user's intent.

Required data structure (the `payment_link_pool` table):
```
payment_link_pool
  id               text PK
  link_identifier  text UNIQUE   -- the resolve key (ideal: reference_id; else plink_ id)
  reference_id     text UNIQUE   -- CCPRO/CCTEAM-XXXXXX (server-issued intent ref)
  plan             text          -- pro | team
  short_url        text          -- the rzp.io/i/... link returned to the user
  status           text          -- AVAILABLE | ASSIGNED | PAID | EXPIRED | REVOKED
  assigned_intent  text NULL FK  -> payment_intents(id)
  assigned_user    text NULL FK  -> users(id)   ( = intent.owner_id)
  assigned_at      timestamptz
  paid_at          timestamptz
  payment_id       text NULL     -- dedup / paid proof
  expires_at       timestamptz
```

This pre-bind CAN be maintained **without the API** — the backend only
*consumes* trusted evidence and *manages its own pool table*; it never calls
Razorpay. **But** the pre-bind is only useful if the evidence can be read back
(Q2) and parsed (Q3), which is unverified — so the pre-bind alone does not make
the pool viable.

---

## CRITICAL QUESTION 5 — Pool management without API

**ANSWER: Yes (CodeConClave-side), with constraints.**

The backend can maintain the pool table (assign, mark PAID/EXPIRED) using only
its own DB + incoming trusted evidence. It does NOT modify Razorpay links.

Hard constraints that remain:
- **Replenishment is manual + human**: creating the links (and their
  reference/notes) is a Dashboard action each time. No API means no automated
  top-up. Every consumed/expired link must be hand-replaced.
- **Ambiguity risk is real**: if the merchant email does NOT reliably carry the
  link's identity (Q2 UNKNOWN), then two different users with two pool links can
  appear as identical generic "payment received" emails → the backend cannot
  tell which link/user paid → correlation fails (the same static-link problem in
  a fancier costume).
- **Reference must be server-issued**: codeconclave must define the reference
  when creating the link, and the Dashboard reference must exactly equal the
  intent reference the backend generated.

---

## CRITICAL QUESTION 6 — Security attack cases (logic)

| # | Attack | Result | Why |
|---|---|---|---|
| 1 | User changes plan | ❌ fails | Amount+plan come from the pre-bound intent/link; only a trusted event carrying the bound reference can activate; a `pro` link can't yield `team`. |
| 2 | User changes email | ❌ fails | Email is never identity; evidence must carry the bound reference; activation is to `intent.owner_id`. |
| 3 | User changes reference | ❌ fails | Reference must equal a server-issued `payment_intents.reference`; arbitrary refs → `404 no_intent`. |
| 4 | User enters another user's reference | ❌ fails | Would resolve to that other user's intent; owner-binding prevents the wrong account being the beneficiary (claim/evidence owner check). |
| 5 | User sends fake paymentId | ❌ fails | paymentId is a dedup key, not identity; forging alone doesn't carry the bound reference / can't pass trusted-source gate. |
| 6 | User claims payment w/o email evidence | ❌ fails | Only trusted evidence (authenticated Gmail / HMAC watchdog) is accepted; user assertions are never issued activation. |
| 7 | Duplicate email | ❌ fails | paymentId / reference dedup — one activation per payment/link. |
| 8 | Replayed event | ❌ fails | Signed timestamp window + dedup + one-time/conditional activation. |
| 9 | Wrong amount | ❌ fails | amount must equal `PLAN_PRICES_INR[plan]` (or the pre-bound link amount); mismatch → rejected. |
| 10 | Wrong plan | ❌ fails | plan bound to link + whitelist; can't cross-activate. |
| 11 | Payment on an unassigned link | ❌ (safe) | Pool entry must be ASSIGNED to an intent + user; an unassigned/AVAILABLE link has no intent → no evidence resolves → no activation (goes to review/no_intent). |
| 12 | Payment on an expired link | ❌ (safe) | `expires_at` check; expired ASSIGNED link won't activate; Razorpay link expiry also blocks new payment. |

If the correlation identifier were reliably present and parsed, the security
controls would be sound. The vulnerability is at Q2/Q3 (ambiguity of which link
paid), not in the described validation logic.

---

## CRITICAL QUESTION 7 — Customer experience (design)

The intended flow is clean and achievable once Q2/Q3 are resolved:
1. Sign in → choose Pro/Team.
2. Backend creates intent + assigns one unused pool link (records bind).
3. Display the assigned unique link to that user.
4. User pays.
5. Razorpay email arrives in merchant Gmail.
6. Apps Script → HMAC → backend extracts the bound reference.
7. Backend verifies plan+amount+dedup+owner → entitlement ACTIVE. No admin.

Customer may wait briefly (≤1-min watchdog) — acceptable. **BUT** the whole flow
depends on the trusted identifier being present + parsed (Q2/Q3), which is
currently UNKNOWN/FAIL.

---

## CRITICAL QUESTION 8 — Pre-created pool scale (10/50/100 users)

| Scale | Feasible without API? | Replenishment |
|---|---|---|
| 10 | Technically possible (manual) | Manual each use. Manageable but tedious. |
| 50 | Possible but fragile | Manual; ~50 links via Dashboard is slow and error-prone; expiry must be monitored by hand. |
| 100 | Not practical | 100 unique links hand-created; every consumed/expired link is a manual job; ambiguity risk high if Q2 unresolved. |

Pool sizing must exceed (users-in-flight) because links are single-use and
expire. Without API there is **no automated top-up**; replenishment is a
recurring **human workload** proportional to volume. This is exactly why the API
(or at least per-link visibility into the email) matters.

---

## CRITICAL QUESTION 9 — Comparison

Rank per axis (1 = best).

| Option | Security | Zero-admin | Reliability | UX | Manual workload | Scalability | Feasible now |
|---|---|---|---|---|---|---|---|
| A. Shared static link | ★★★ (no per-user id) | ❌ | ★★ | ★★ | Low | ★★ | ✅ (but can't correlate) |
| **B. Pre-created unique pool (no API)** | ★★★★ (if Q2/Q3 OK, else ★★) | ★★★★ (auto) but manual replenish | ★★★ (depends on email content) | ★★★★ | **High** (manual, unbounded) | ★★★ (thin) | ❌ (Q2 UNKNOWN) |
| C. Razorpay API dynamic links | ★★★★★ | ★★★★★ | ★★★★★ | ★★★★★ | Low | ★★★★★ | ❌ (no API) |
| **D. API + signed webhook** | ★★★★★ | ★★★★★ | ★★★★★ | ★★★★★ | Lowest | ★★★★★ | ❌ (needs capability) |

- **B** is the only one that could work without API, but it is gated on an
  **unverified** assumption (merchant-email→reference correlation) and carries a
  **permanent manual replenishment** cost that does not scale to 50–100.
- **C/D** remain the correct architectures once Razorpay capability (KYC +
  verified website + Live API keys) is available.

---

## FINAL DECISION

- The pool concept (Dashboard links with unique `reference_id`, pre-bound
  server-side) is **structurally correct and clever** — it is the closest thing
  to a no-API zero-admin design.
- It is **NOT provably viable today** because the decisive promise
  ("merchant confirmation email reliably contains the link's reference/identity,
  and the watchdog parses it") is **UNKNOWN (unverified in official docs)** and
  the current parsers do not support it. Declaring VIABLE would require assuming
  exactly what you told me not to assume.
- Additionally it has **unavoidable manual replenishment** and breaks down at
  realistic scale.

Therefore:

**PRECREATED_LINK_POOL = NOT_VIABLE** (currently; not provably viable)

The correct path remains: obtain trusted Razorpay capability (API for per-intent
dynamic links + optional signed webhook) and use the existing, already-implemented
rails (`razorpay_api`, `razorpay_webhook`, and `gmail`-with-reference). The pool
idea can be revisited ONLY after a **live, no-money test** proves the merchant
email actually contains a reliable per-link identity the watchdog can parse.

---

## FINAL RESPONSE

**SHARED_STATIC_LINK = UNSAFE_FOR_ZERO_ADMIN**

**PRECREATED_LINK_POOL = NOT_VIABLE** (unverifiable today; gated on an UNKNOWN)

**DASHBOARD_REFERENCE_ID = SUPPORTED** (Dashboard Standard Payment Link has an
optional unique Reference Id, ≤40 chars; also Notes + customer + amount — no API)

**REFERENCE_IN_MERCHANT_EMAIL = UNKNOWN** (Razorpay does not document the
merchant notification email body; only API/webhook/callback/3rd-party templates
are documented)

**LINK_ID_IN_MERCHANT_EMAIL = UNKNOWN** (same)

**GMAIL_EXTRACTION = FAIL** (current parsers only match `CC(PRO|TEAM)-[A-Z0-9]{6}`;
no `plink_`/arbitrary-`reference_id` extraction; `.gs` source not inspectable)

**EXACT_USER_CORRELATION = UNKNOWN/FAIL** (depends on Q2/Q3 correlation
identifier, which is unverified; without it, two users on two pool links can be
indistinguishable → the same correlation failure as the static link)

**NO_API = YES**  **NO_WEBHOOK = YES**  **NO_ADMIN = YES**
**AUTO_UNLOCK = NO** (cannot be made trustworthy until Q2/Q3 are proven with a
live no-money test and new parser code — neither of which is permitted now)

**RECOMMENDED_NOW =** Do NOT build the pool. Do not declare it viable. The only
trusted zero-admin path is to obtain the Razorpay **API capability (per-intent
dynamic links)** + optional **signed webhook**, using the already-implemented
`razorpay_api` / `razorpay_webhook` / `gmail`-with-reference rails. If you ever
wish to pursue the no-API pool, first run a **live no-money read-only test** of a
merchant confirmation email to confirm it carries a parseable per-link identity,
and only then write a new parser + binding.

**RECOMMENDED_FINAL = Razorpay API + signed webhook (+ Gmail secondary)** with
per-intent dynamic Payment Links carrying a unique `reference_id` — matching
`docs/FINAL_RAZORPAY_ZERO_ADMIN_ACCESS_PLAN.md` and
`docs/FINAL_GOOGLE_APPS_SCRIPT_ZERO_ADMIN_AUDIT.md`.

**REAL_PAYMENT = NOT_PERFORMED**
**DEPLOYMENT = BLOCKED**
**SOURCE_CHANGES = NONE**

**STOP**
