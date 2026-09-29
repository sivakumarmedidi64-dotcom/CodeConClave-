# CodeConClave — FINAL 24/7 ZERO-ADMIN PAYMENT FEASIBILITY AUDIT

> Date: 2026-08-31. Production freeze ACTIVE. Read-only audit: no code change, no deploy,
> no real payment, no secrets exposed. Authoritative Razorpay Payment Link behavior cited.

## Verdict
**NO_API_NO_WEBHOOK_NO_ADMIN = NOT_POSSIBLE_WITH_CURRENT_RAZORPAY_SETUP**

With a **static Payment Link + Razorpay emails + Gmail reader + no API + no webhook**,
there is **no trustworthy, deterministic, per-user payment correlation**. The reason is
structural: a static Payment Link is a single shared checkout entity with a **fixed
`plink_…` id, fixed `reference_id`, fixed `short_url`** for ALL customers, and no
per-intent value that the CodeConClave backend pre-recorded to map a payment to exactly
one user. Confirmation emails therefore cannot carry a unique CodeConClave intent reference.

## Provider-signal table (14 signals)

Legend: PG=provider-generated, TAM=tamperable by customer,
UNIQ=unique per intent, SL=available with static link,
NAPI=available without API, NWB=available without webhook, SAFE=safe correlation anchor.

| # | Signal | PG | TAM | UNIQ | SL | NAPI | NWB | SAFE |
|---|--------|----|----|----|----|----|----|----|
| 1 | Payment Link ID (`plink_…`) | YES | NO | **NO** (one per static link, shared) | YES | n/a | YES | **NO** |
| 2 | Payment Link short URL | YES | NO | **NO** (shared) | YES | n/a | YES | **NO** |
| 3 | `reference_id` | YES | NO | **NO/per-link, set via API** | **NO** (requires API to set per intent) | **NO** | n/a | **NO** |
| 4 | `notes` | YES | NO | NO (per-link, set via API) | NO (requires API) | NO | n/a | **NO** |
| 5 | transaction/payment ID (`pay_…`) | YES | NO | UNIQUE per payment | YES (in email) | NO mapping exists | YES (in email) | **NO** (cannot map to intent without API/webhook) |
| 6 | receipt/invoice number | YES | NO | unique | YES | NO mapping | YES | NO |
| 7 | payer email | customer-entered | **YES** (typed at checkout; Razorpay docs: not auto-populated) | NO (shared/masked/alias) | YES | YES | YES | **NO** (signal only) |
| 8 | customer ID | YES | NO | account-level | NO | NO | no | **NO** |
| 9 | phone number | customer-entered | YES | NO | YES | YES | YES | **NO** |
| 10 | payment timestamp | YES | NO | unique | YES | NO mapping | YES | NO |
| 11 | invoice/reference number in email | provider/merchant | — | — | depends | — | — | **NO** |
| 12 | any provider merchant reference | YES | NO | per-link (static) | YES | NO | YES | **NO** |
| 13 | customer-entered immutable/trusted id | **none** (any typed value is customer-controlled) | — | — | — | — | — | **NO** |
| 14 | confirmation-email field deterministically identifying intent/user | **NO** (only shared link id + customer email + payment id, none mapped to intent) | — | — | — | — | — | **NO** |

**Directives honored:** email equality is NOT treated as sufficient; nothing customer-typed
is treated as immutable/trusted; nothing is assumed to be in the email merely because the
field exists.

## Static-link test (multi-user)
User A and User B each pay the **same static Pro link**. Their receipts carry the **same**
`plink_…`/link reference, a distinct `pay_…` id, and the payer's self-typed email. The
backend has **no pre-recorded per-user mapping** for `pay_…` (that mapping is created only
when the API mints a per-intent link), and payer-email equality is not trustworthy.
⇒ Backend **cannot reliably determine which user paid** ⇒
**STATIC_MULTIUSER_CORRELATION = IMPOSSIBLE**.

## Email-only test
A Razorpay confirmation email (static link) contains: amount, `pay_…` id, `plink_…` (shared),
timestamp, payer email (customer-typed). Non-mutable, intent-mapped values the system can
use are absent. `pay_…` exists in the email but **cannot be resolved to a CodeConClave intent
without API/webhook** (no server-side mapping). The `plink_…` is shared by all customers.
⇒ Email alone **cannot** uniquely map payment → intent → user.

## Customer-email test ⇒ PAYER_EMAIL = SIGNAL_ONLY
Considered: same email on multiple accounts, aliases, masked emails, changed emails,
payment made using another person's email, shared/family/company email, spoofing, account
takeover. Email equality is neither unique nor independently verifiable; in CodeConClave it
is already modeled as a **signal only** (+0.10 confidence; flagged `sender_anomaly` on
mismatch), never the activation anchor. Insufficient for trust.

## Transaction-id test ⇒ FAIL
Mapping `pay_…` / receipt / `plink_…` → intent requires a pre-recorded provider binding,
which is only created when the **API** mints a per-intent link (`provider_payment_link_id` /
`provider_reference_id` stored at creation). With a static link and no API/webhook, no such
binding exists and none can be resolved. Precise reason: the resolution endpoint is behind
the Razorpay **API**, which is deferred; the mapping row is only written at API mint time.

## Redirect test ⇒ UNSAFE
`handleReturn` treats the browser `?paid=`/`?status=` values as non-authoritative and stays
PENDING without API. The signed redirect parameters
(`razorpay_payment_id`, `razorpay_payment_link_id`, `razorpay_payment_link_reference_id`,
`razorpay_signature`) can only be **signature-verified with the API key_secret**, which is
unavailable. Browser-controlled → **UNSAFE as authority** (correctly never used as one).

## Gmail-watchdog test ⇒ FAIL (for static-link multi-user activation)
`sweepPendingIntentEvidence` reuses the exact-reference pipeline and its contract states:
"reference-less static-link receipts are **dropped upstream**." It can only activate an
email whose reference exactly matches a specific intent's `CCPRO-…`/`CCTEAM-…`. Static-link
emails carry no per-intent reference ⇒ collector returns nothing ⇒ intents stay PENDING/
REVIEW. It cannot identify the exact payment/user for simultaneous static-link payers.

## 24/7 recovery test ⇒ FAIL as a zero-admin path
Idempotency, replay, exactly-once, backoff/retry, and bounded sweeps are correct and safe
(delayed/duplicate/missing/out-of-order email, Gmail outage, backend restart, watchdog
restart, retry, duplicate checkout are handled as no-ops or retried, and refund/chargeback
are modeled) — **but** none of that matters without the correlation anchor. Since it cannot
disambiguate simultaneous static-link payers, it cannot auto-activate them. Recovery from
the correlation failure is impossible without a trusted per-user signal.

## Trust requirement
`TRUSTED_PROVIDER_SIGNAL ✗` and `UNIQUE_PAYMENT_CORRELATION ✗` for the static-link path.
Without these, `EXACT_USER_ASSOCIATION` cannot be established, so the entitlement cannot be
safely set ACTIVE. The trust boundary is **PASS** (no insecure path), which is exactly why
zero-admin is **BLOCKED** rather than risked.

## No-API/no-webhook option search
Systematically excluded as unsafe: hidden APIs, undocumented endpoints, scraping hacks,
browser automation, fake references, email-only assumptions, customer-controlled tokens.
**No safe mechanism exists** in the current Razorpay static-link + CodeConClave setup.

---

## Minimum single constraint to change (ranked)
1. **Razorpay signed webhook** (keep static links as checkout; add signed `payment_link.paid`
   webhook ⇒ provider-authoritative event, zero-admin, 24/7). ← smallest change to reach target.
2. **Razorpay API** (mint per-intent reference-bound links; the reference then flows through
   the payment/email and the Gmail rail + reconciliation can authenticate). Enables
   correlation without a webhook.
3. **Another trusted payment provider with API/webhook support** (analogous capability).
4. Other provider-side mechanism — none identified that is currently available.

The only <1-constraint> change that satisfies all ten business requirements simultaneously is
a **provider-authoritative event/correlation channel (signed webhook and/or per-intent
API-minted links)**. Admin is NOT a valid normal path per the product requirement
(zero-admin), so it is excluded.

---

```
# CODECONCLAVE 24/7 ZERO-ADMIN PAYMENT FEASIBILITY
NO_RAZORPAY_API     = YES
NO_RAZORPAY_WEBHOOK = YES
NO_ADMIN            = YES
AUTO_UNLOCK         = REQUIRED
24x7                = REQUIRED

STATIC_LINK           = UNSAFE
PER_USER_CORRELATION  = FAIL
GMAIL_CORRELATION     = FAIL
PAYER_EMAIL           = SIGNAL_ONLY
TRANSACTION_ID        = FAIL
REDIRECT              = UNSAFE
WATCHDOG              = FAIL
24x7_RECOVERY         = FAIL (hardening PASS; correlation FAIL ⇒ cannot auto-activate)
TRUST_BOUNDARY        = PASS

NO_API_NO_WEBHOOK_NO_ADMIN = NOT_POSSIBLE

MINIMUM_REQUIRED_CAPABILITY = Razorpay signed webhook
                              (OR Razorpay API for per-intent reference-bound links)

RECOMMENDED_FINAL            = Signed Razorpay webhook (Option C); eventual D = API + webhook
PRODUCTION_FREEZE            = KEEP
REAL_PAYMENT                 = NOT_PERFORMED
DEPLOYMENT                   = BLOCKED
```

## Production freeze recommendation
**KEEP the freeze.** The current safe architecture (static links = checkout only, Gmail =
trusted review rail, manual/OCR = REVIEW only) is correct and should not change. No insecure
workaround was invented, production code is unchanged, no payment was made, and the safe
REVIEW fallback is intact. True 24/7 zero-admin becomes possible only when a Razorpay signed
webhook (and/or API) capability is actually available and enabled — pending approval.
