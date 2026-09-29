# FINAL ACTIVATION-CODE ENGINE FEASIBILITY

> **Scope:** Design the safest possible activation-code architecture that can
> sit on top of the existing payment system. **No code changed. No deployment.
> No real payment. No secrets.** Answer whether an activation-code layer can
> solve the current static-link correlation problem without the Razorpay
> API/webhook.

---

## 0. Executive verdict

**HEADLINE: ACTIVATION_CODE_WITH_CURRENT_STATIC_LINK = CANNOT_SOLVE_PAYMENT_TRUST**

An activation-code engine is an **entitlement-redemption** mechanism, NOT a
**payment-verification** mechanism. It can only be *issued* when a **trusted
event** proves a payment is real AND resolves it to an exact user/plan. With the
current static Payment Links there is **no trusted event** that can perform that
resolution, so no code can ever be issued. Adding a code layer on top of static
links does not create trust that does not exist — it simply relocates the
unsolvable correlation problem.

- **ACTIVATION_CODE_ENGINE = RECOMMENDED** (as a UX layer on top of a trusted
  verification rail in the FUTURE architecture).
- **CURRENT_STATIC_LINK_SUPPORT = NO** (cannot issue a code; no trusted
  correlation).
- **CURRENT_ZERO_ADMIN = IMPOSSIBLE** (until trusted Razorpay correlation).
- **CODE_AS_PAYMENT_PROOF = NO** — the code is NEVER proof of payment; only a
  trusted verified event may ISSUE a code.

---

## 1. The critical trust rule (who may ISSUE a code)

The code must never be derived from anything the user (or attacker) asserts.
Issuance is a **server-side, event-driven** action gated by the same trust
boundary as the existing rails (`pipeline.ts:55` trusted set + `gmail-claim`
rail).

| Event | Can ISSUE a code? | Why |
|---|---|---|
| Signed Razorpay webhook | ✅ TRUSTED | `razorpay_webhook` evidence; HMAC-verified; resolves via provider `reference_id`. |
| Razorpay API verification | ✅ TRUSTED | `razorpay_api` evidence; API fetch matched by `notes.reference`/`notes.session_id`. |
| Authenticated Gmail evidence WITH exact intent reference | ✅ TRUSTED (only if it proves exact intent) | `gmail` evidence source requires `ref === reference` (strict); fails for static links (no reference). |
| Apps Script HMAC event WITHOUT a resolvable reference | ❌ NOT TRUSTED | It would carry no user–intent binding → no intent → no code. |
| User says they paid | ❌ | Never. |
| User-entered payment ID | ❌ | Dedup key, never identity. |
| Screenshot / OCR | ❌ | Forced to REVIEW (`effectiveMatch`). |
| Redirect/callback/URL params | ❌ | Client-side claim, never verifiable. |
| Arbitrary email address | ❌ | Email alone is spoofable; not trusted. |
| Client-side success flag | ❌ | Never. |

> Rule of thumb: **the SAME trusted evidence that can today drive an intent to
> ACTIVE (`gmail` w/ reference, `razorpay_api`, `razorpay_webhook`) is the ONLY
> set that may trigger code issuance.** User-asserted sources (manual/ocr) may
> never issue a code.

---

## 2. Why an activation-code layer cannot solve the static-link problem

The current blocker (confirmed in `docs/FINAL_GOOGLE_APPS_SCRIPT_ZERO_ADMIN_AUDIT.md`)
is **user–payment correlation**, not UX. With the shared static links:

- The Razorpay confirmation email carries **no per-user `CCPRO/CCTEAM`
  reference**.
- The backend `gmail` evidence source and the `gmail-claim` rail both **refuse
  to act without that reference** (`evidence.ts:305-307`, `gmail-claim.ts:262`).
- Therefore **no trusted issuer event exists**, and a code cannot be created for
  the correct recipient.

A code engine would require a `(user, plan, amount, reference, paymentId)` set
to bind the code. For a static-link payment, `reference` is null and the user is
indistinguishable from every other payer of the same link. There is nothing to
bind the code to. **The code cannot bridge that gap.** The trusted correlation
must come from the payment method (API/webhook + per-intent links), not from the
activation-code layer.

> **ACTIVATION_CODE_WITH_CURRENT_STATIC_LINK = CANNOT_SOLVE_PAYMENT_TRUST**

Do not invent a workaround (e.g. minting a code when a generic "Razorpay receipt
with matching amount" email appears) — that would (a) not identify the correct
user and (b) treat amount+email as identity, which is explicitly forbidden and
would let a wrong user claim / an attacker learn codes exist for a payment.

---

## 3. Secure activation-code engine design (future, reusable)

This design is fully reusable once the trusted Razorpay correlation exists, and
is compatible with **Razorpay API + signed webhook + Gmail secondary
reconciliation** (Option D). It reuses existing primitives (`crypto.ts`:
`randomBase32`/`randomToken`, scrypt, timing-safe compare; `ids.ts`: new prefix;
`outbox`/`notify`/`recordAudit`).

### 3.0 Issuance trigger (the trusted gate)
Code issuance is called **only from** the trusted verification path:
`activateEntitlement()` is today the shared activation hook. The code engine
sits **between** "trusted payment verified" and "entitlement ACTIVE": the trusted
event marks the intent `PENDING_ACTIVATION` and ISSUES a code; redemption of the
correct code moves it to ACTIVE. The flow (Option C) preserves all existing
security invariants while adding a UX step.

### 3.1 Code generation (1.)
- Use `randomBase32(10)` (CSPRNG, ~50 bits) formatted as `XXXXX-XXXXX` (uppercase,
  unambiguous alphabet A–Z, 2–7, no 0/O/1/I). Or `randomToken()` for a
  longer/high-entropy variant. Use a fresh CSPRNG draw per code; never derive
  from time/ids/email.

### 3.2 Hashing / storage (2.)
- **Never store the raw code.** Store `code_hash`.
- Because a 10-char base32 code is **low-to-medium entropy** (~50 bits) and
  could be offline-brute-forced, **hash with a keyed, salted, iterated KDF** —
  reuse `hashSecret()` (scrypt, per-code random salt) or an HMAC with a
  dedicated server secret (`CODE_HMAC_SECRET`). Do **not** use bare SHA-256,
  which is fast and allows offline guessing of a leaked DB.
- Store: `id, owner_id, intent_id, plan_id, amount_inr, reference, payment_id,
  payer_email, code_hash, attempts, last_attempt_at, status, issued_at,
  expires_at, redeemed_at`.

### 3.3 Expiration (3.)
- Short-lived by default (e.g. `ACTIVATION_CODE_TTL_MINUTES = 30`), enforced by
  `expires_at > now()` on every redemption. Refund/revocation can force-expire.

### 3.4 Max redemption attempts (4.)
- Cap at e.g. **5 attempts per code**; beyond that, lock the code
  (`status='LOCKED'`) and require re-issue (regeneration). Also cap per-user
  and per-IP as abuse guard.

### 3.5 One-time consumption (5.)
- `code_hash` is `UNIQUE`. Redemption is a **conditional
  `UPDATE ... WHERE status='ISSUED' AND expires_at > now() AND attempts < max`
  RETURNING ***` — an atomic exactly-once race guard (same pattern as
  `gmail-claim.ts:375-388`), then call `activateEntitlement(owner, plan,
  intent)`. Status → `REDEEMED`; raw code becomes permanently unusable.

### 3.6 Account binding (6.)
- Code is bound to `owner_id` at issuance (the intent owner — server-derived).
  Redemption **requires the authenticated session user to equal `owner_id`**.
  A different account cannot redeem another user's code (tenant isolation;
  no `owner_id` override).

### 3.7 Plan binding (7.)
- Code carries `plan_id` derived from the intent (server-authoritative). Redeem
  only activates that plan. A `pro` payment can never redeem `team`.

### 3.8 Amount binding (8.)
- Code carries `amount_inr` from the intent. Redemption does not trust any
  client amount; the trusted event already validated it against
  `PLAN_PRICES_INR`. (Optionally render it in the email for the user.)

### 3.9 Payment/reference binding (9.)
- Code is stored against `payment_id` (dedup: one code per payment) and
  `reference` (the server-issued intent reference). Issuance requires a
  non-empty, resolvable `reference` — this is exactly why **static links cannot
  issue a code**.

### 3.10 Replay protection (10.)
- Redemption is one-time + TTL-bounded + attempt-capped. A replayed code after
  `REDEEMED` returns locked/invalid; after TTL returns expired. Combined with
  the intent already ACTIVE, further redemptions are moot.

### 3.11 Idempotency (11.)
- **One code per (owner, intent, payment)** — index/guard on `intent_id` and on
  `payment_id`. Duplicate issuer event (webhook redelivery, API double-poll,
  Gmail double-match) must not mint a second code; reuse the identical existing
  code (and resend it, rate-limited) rather than minting a new one.

### 3.12 Email delivery (12.)
- Deliver via the existing transactional **outbox** (`enqueueOutbox`, dedupe-keyed)
  so it is retried and audited. Email to the **intent owner's verified email**
  (server-derived), NOT to an arbitrary address from an untrusted payload.
  Never log/store the raw code anywhere; only inline it in the email body at
  build time.

### 3.13 Abuse / rate limiting (13.)
- Rate-limit issuance (per user, per intent, per payment) via the existing
  rate-limit/velocity guardrails. Do not allow unbounded re-issuance.

### 3.14 Brute-force protection (14.)
- Attempt cap + lockout (3.4/3.5), per-user+per-IP throttle, and **keyed
  brute-force-resistant hashing** (3.2). Timing-safe comparison on verify.
  Because the code is emailed to the verified owner, online brute force is the
  only meaningful vector and is capped.

### 3.15 Audit trail (15.)
- `recordAudit` on: `code_issued`, `code_email_sent`, `code_redeemed`,
  `code_failed_attempt`, `code_expired`, `code_locked`, `code_regenerated`,
  `code_revoked`. Full actor/tenant/resource detail, sanitized.

### 3.16 Refund / revocation (16.)
- A refund/dispute (webhook `payment.refunded`/{event}) sets the intent/code to
  a revoked state; `activateEntitlement` and the entitlement-expiry machinery
  already handle downgrade/revoke. A pending code is force-expired. A redeemed
  code already activated is handled by the existing entitlement
  refund/expiration logic (not by deleting the code record).

### 3.17 Code regeneration (17.)
- Regeneration is allowed ONLY while the underlying payment remains verified and
  the prior code is expired/locked/lost — never for a new/unverified payment.
  Each regeneration mints a new code, invalidates the old (status/expired), and
  is rate-limited + audited.

### 3.18 Duplicate payment behavior (18.)
- A second code issuance for the same (owner,intent,payment) is idempotent
  (3.11). Two distinct intents with two distinct payments each get their own
  code. The same `payment_id` never yields two codes (payment dedup).

### 3.19 Lost-email behavior (19.)
- A verified user can request a **regeneration** (3.17), which requires the
  underlying verified payment and correct authenticated session, is
  rate-limited, and re-runs the trusted issuer check. Never re-issue without a
  still-valid trusted payment.

### 3.20 Account-mismatch behavior (20.)
- Redemption by a session user whose `owner_id != intent.owner_id` is rejected
  (403/404), audited, and increments the attempt counter. The code is never
  transferable after binding.

---

## 4. The code never bypasses anything

By construction the code:
- cannot grant arbitrary plans (bound `plan_id`),
- is not reusable / not predictable / not stored raw,
- is not transferable after binding (owner match enforced),
- cannot bypass payment verification (issuance requires a trusted event),
- cannot override user identity (entitlement owner = intent owner),
- cannot bypass tenant isolation (owner check on every path),
- cannot bypass entitlement expiration/refund logic (activation reuses the
  existing shared entitlement machinery).

**CODE_AS_PAYMENT_PROOF = NO.** The code is a redemption artifact for an already-
verified payment; possessing it proves nothing and grants nothing without the
server-side trusted-issuer correlation behind it.

---

## 5. Option comparison

Rank 1 = best … 5 = worst for zero-admin, security, UX, reliability, and
future scalability. Feasibility now is gated by the static-link constraint.

| Option | Security | Zero-admin | UX | Reliability | Feasible now | Future scale |
|---|---|---|---|---|---|---|
| **D. API/webhook + code issuance (Option E in prior doc / C here)** | ★★★★★ | ★★★★★ | ★★★★★ | ★★★★★ | ❌ (needs Razorpay capability) | ★★★★★ |
| **C. Payment verified first + activation-code redemption** | ★★★★★ | ★★★★★ (one email+code entry, no admin) | ★★★★★ | ★★★★★ | ❌ | ★★★★★ |
| **B. Automatic entitlement + activation code** (redundant code) | ★★★★★ | ★★★★☆ (extra step) | ★★★☆☆ | ★★★★☆ | ❌ | ★★★★☆ |
| **A. Direct automatic entitlement** (no code) | ★★★★★ | ★★★★★ | ★★★★★ | ★★★★★ | ❌ | ★★★★★ |
| **D-Gmail-only. Gmail-only code issuance** | ★★★☆☆ | ★★★★★ | ★★★★☆ | ★★★★☆ | **BLOCKED** | ★★★☆☆ |

Ranking (overall, once Razorpay capability is available):
1. **C. Payment verified first (+ activation code)** — the recommended
   activation-code architecture. Trusted verification gate + clean UX + full
   security.
2. **A. Direct automatic entitlement** — simplest and equally secure; if the
   founder does not need the "enter code" ritual, direct auto-activation is
   superior (no code, no step-4/6 friction). The code is optional UX.
3. **D. API/webhook + code (equivalent to C's issuer path)** — the underlying
   enabler; code on top.
4. **B.** — a redundant code after entitlement already active adds friction with
   no benefit.
5. **D-Gmail-only (Gmail-only code issuance).** — risky today because Gmail-only
   cannot prove exact intent for static links; it would not be a trusted
   issuance source. **BLOCKED for current setup.**

> **Recommended final architecture:** D-compatible issuer (Razorpay API +
> signed webhook + Gmail secondary reconciliation) → trusted verified payment →
> **C: mint code, email it, customer enters it → auto-Activate.** If the
> "enter code" ritual is not a product requirement, use **A (direct
> auto-activation)** with an optional emailed code as a confirmation artifact.

---

## 6. What stays unchanged

- Trust boundary: only trusted events issue codes (same sources that can reach
  ACTIVE today).
- Server-authoritative plan/amount/reference; no client-trusted values.
- `PLAN_PRICES_INR`, `activateEntitlement`, idempotency, replay protection,
  anti-self-activation, tenant isolation, audit.
- Security controls from the gmail-claim rail (HMAC, timestamp, dedup) are
  reused/strengthened, never weakened.

---

## 7. Implementation required?

**Not now.** The engine is **feasible and RECOMMENDED as a future layer**, but it
cannot be enabled until trusted Razorpay correlation exists. Implementing it now
would create an engine with no trusted issuer event (dead code that must not be
wired to static-link emails to avoid unsafe behavior). It should be built **after**
Razorpay API/webhook capability is granted and per-intent links are in use.

- **IMPLEMENTATION_REQUIRED = NO** (now). YES once the trusted Razorpay
  capability lands.

---

*End. No code, no deploy, no payment, no secrets.*
