# CodeConClave — Payment Zero-Admin Feasibility Audit Gate

> Date: 2026-09-03. Type: **read-only audit + feasibility gate**. No production code
> changed, no deployment, no real payment, no secrets exposed, no admin activation
> created, no entitlement granted. `SOURCE_CHANGES = 0` unless a connecting change is
> later approved. Every claim below is traced to repo source under
> `backend/src/modules/payments/` and `backend/src/config/env.ts`.

---

## 0. The question

**Is automatic zero-admin payment activation feasible without the Razorpay API or Webhook?**

Strictly defined, "automatic zero-admin" means **no human action of any kind after the
customer pays**: no founder, no admin, **and no customer click**. Only a purely
watchdog-driven path qualifies.

---

## 1. What already exists (built, not hypothetical)

Two rails already live in the repo that touch zero-admin activation. They are different
mechanisms and must not be conflated.

| Rail | Source | Activation trigger | Human action after payment? | Mount |
|------|--------|--------------------|-----------------------------|-------|
| **A. Gmail evidence rail + mailbox watchdog** | `evidence.ts` `gmailSource`; `service.ts` `sweepPendingIntentEvidence`; `watchdog.ts` `mailboxReceipts`; `intents.ts` `sweepIntentExpiry` | Watchdog polls PENDING/REVIEW intents, reads the mailbox, and drives the trusted pipeline to **ACTIVE** | **NONE — fully automatic, zero click** | in-process watchdog (every 15 s) |
| **B. Gmail claim rail** | `gmail-claim.ts` + `gmail-claim-routes.ts` + migration `0057_gmail_claim_rail.sql` | Apps Script → HMAC-signed POST → backend creates one-time claim token → emails claim link → **payer clicks link to activate** | **YES — payer must click the claim link** | `/api/v1/payments/gmail-claim` (mounted in `app.ts:216`) |

**Critical distinction:** Only Rail A is *automatic zero-admin* (no click). Rail B is
*near-zero-admin* (one customer click) and is not truly automatic. The audit question asks
about automatic activation, so Rail A is the decisive mechanism.

---

## 2. How Rail A (the decisive one) decides — traced

`watchdog.ts:68` calls `sweepPendingIntentEvidence()` every sweep. It:
- bounds work to 25 intents/cycle (`service.ts:598`),
- rate-limits per-intent to ≥ 30 s (`MAILBOX_SWEEP_BACKOFF_MS`, `service.ts:599`),
- is a **contained no-op** when the Gmail rail is unconfigured: `gmailDetectorAvailable()`
  is false → `throw AppError.conflict('evidence_source_blocked', ...)` (`service.ts:605`,
  `evidence.ts:196-201`), which `watchdog.sweep` catches and logs — no crash, no state change.

For a PENDING/REVIEW intent to become ACTIVE end-to-end, all of the following must hold
(any failure → PENDING/REVIEW, **never** ACTIVE):

1. `gmailSource.collect` finds a Razorpay receipt for the exact intent reference.
2. **Origin gate** `isAuthenticRazorpayMail` passes — DMARC/SPF/DKIM `pass` bound to
   `razorpay.com` **and** `From` domain `razorpay.com` (`evidence.ts:247-260`). A spoofed
   message is never evidence.
3. **Exact reference binding** — the message must contain the exact server-issued
   `CCPRO-…`/`CCTEAM-…` (`evidence.ts:304-307`); **a reference-less static-link receipt is
   dropped** (this is the stated, enforced contract).
4. `scoreEvidence` (matcher) reaches `confidence ≥ 0.8` (default `PAYMENT_CONFIDENCE_ACTIVE`,
   `env.ts:95`). Reference is the anchor signal (+0.45 of 1.0).
5. `effectiveMatch` — `gmail` is in `TRUSTED_EVIDENCE_SOURCES` (`pipeline.ts:55`), so a
   trusted source *may* reach ACTIVE (unlike `ocr`/`manual`, which are forced to REVIEW,
   `pipeline.ts:66-78`).
6. `applyDecision` (activation) conditional PENDING/REVIEW→ACTIVE `UPDATE` wins the race
   (`activation.ts:111-123`); fraud-blocked evidence → REVIEW, never ACTIVE.

**Verdict on Rail A:** the engine is complete, idempotent, exactly-once, replay-guarded,
and requires zero human/click/admin. It **will** auto-activate **if and only if** the receipt
carries the exact reference.

---

## 3. Evidence field analysis (what a static-link receipt contains → can it correlate?)

Static links are **shared, fixed-identity** checkouts:
- `RAZORPAY_PRO_PAYMENT_LINK = https://rzp.io/rzp/sAgHIpxS`
- `RAZORPAY_TEAM_PAYMENT_LINK = https://rzp.io/rzp/3ioXlCxd`
- defined as single constants in `env.ts:89-90` / `service.ts:48-59`; one link per plan,
  **re-used by every customer** of that plan.

A static-link Razorpay confirmation carries (provider-side): shared `plink_…`, distinct
`pay_…`, payer-typed email, amount, timestamp, invoice/receipt number. None of these is a
per-Intent value the backend pre-recorded. The **only** per-intent key the CodeConClave
backend mints is the `reference` string (`CC{PLAN}-XXXXXX`, `intents.ts:79-88`), which the
**customer is instructed to type into the payment remarks/description**
(`intentInstructions`, `intents.ts:166-185`).

So correlation via Rail A depends on one empirical fact:

> **Does a Razorpay payment-confirmation email for a shared static-link payment echo the
> customer-typed payment description/remarks — and therefore the typed unique reference?**

- If **YES** → the receipt carries the exact reference → `gmailSource` releases it → Rail A
  auto-activates, **zero admin and zero click**. Feasible.
- If **NO** → the receipt is reference-less → dropped upstream → intent stays PENDING/REVIEW
  → **not** automatically activated. Rail A cannot disambiguate two customers who paid the
  same static link (the `FINAL_24_7_ZERO_ADMIN_PAYMENT_FEASIBILITY` "static multiuser test").

**This fact is NOT provable from the repo source.** It is external Razorpay behavior. Prior
audits explicitly flagged it **UNVERIFIED** (no live no-money test permitted). Per the rule
"never fabricate payment truth" and "never invent Razorpay capabilities," I record it as
UNVERIFIED, not assumed true.

---

## 4. Exact-correlation test (two users, same static link, no typed reference)

User A and User B each pay the **same static Pro link** without typing a reference.
Both receipts share `plink_…`, carry distinct `pay_…`, and a self-typed email. Rail A's
collector requires `ref === reference` and finds none → **no evidence released → both
intents stay PENDING**. No safe mechanism (from the systematic no-API/no-webhook search in
`FINAL_ZERO_ADMIN_PAYMENT_CURRENT_CAPABILITY_GATE.md`) can disambiguate them without a
per-intent provider binding. **STATIC_MULTIUSER_NOREF_CORRELATION = FAIL.**

---

## 5. Watchdog transport security (Rail A)

- Server-side OAuth mailbox read (`users/me/messages`), never browser/localStorage.
- Origin-authenticated only (`isAuthenticRazorpayMail`); spoofed mail is never evidence.
- Never trusts payer email alone; exact reference + amount + window + fraud/replay required.
- Contained when unconfigured; bounded, rate-limited, idempotent, audited.
- `TRUSTED_EVIDENCE_SOURCES` gate ensures only `gmail`/`api`/`webhook` may reach ACTIVE;
  user-asserted `ocr`/`manual` are forced to REVIEW.
- **Watchdog transport security: PASS** — the engine never weakens the trust boundary.

---

## 6. 24/7 feasibility

Rail A is driven by the **in-process watchdog** (`watchdog.ts`), which runs every 15 s while
the backend is up. Sweeps are idempotent; a restart, outage, duplicate, missing, or
out-of-order email is a no-op or retried. The Gmail collector honestly reports
availability (`gmailDetectorAvailable`). **24/7 operation is structurally supported.**
The binding constraint is not uptime — it is the correlation fact from §3.

---

## 7. Zero-admin test (strict)

- **Rail A (watchdog)** requires **no** admin, founder, customer click, or ticket → **PASS
  as an engine**, conditional on §3.
- **Rail B (claim)** requires a **customer click** → **FAIL** as *automatic* zero-admin
  (it is *near*-zero-admin).
- **Admin activation does not exist as a normal path** — control center is **read-only**
  (`control-center.ts`; verified: only GET handlers, no activate/approve/force/grant;
  `activation.applyDecision` is the sole ACTIVE gate). Consistent with zero-admin goal.

---

## 8. Entitlement safety

The **only** path to a `PRO_VERIFIED` entitlement is `activateEntitlement` reached via
`applyDecision` (`activation.ts:111-125` → `service.ts:418-427`), which:
- requires a trusted evidence source,
- requires `confidence ≥ ACTIVE` threshold,
- is fraud-gated (fraud-blocked → REVIEW → never ACTIVE),
- is exactly-once (conditional `UPDATE … WHERE status IN ('PENDING','REVIEW')`, plus
  sha256 replay dedupe).
No client/App-Script/admin input can grant entitlement from unknown correlation.
**Entitlement safety: PASS.** The claim rail (`gmail-claim.ts`) also routes through
`activateEntitlement` only after its one-time token + expiry + single-use guards, and never
promotes weak evidence (its `requestGmailClaim` still validates plan + server-authoritative
amount + reference → existing intent).

---

## 9. Refund / subscription handling under no-API/no-webhook

- **Detecting a refund requires a trusted refund-event source.** With no API and no webhook,
  the system **cannot auto-detect a refund**: `payment.refunded` is only handled via the
  signed-webhook rail (`routes.ts:441`); `refundIntent` (`activation.ts:166`) / auto-revoke
  (`intents.ts:248` grace path) already exist but depend on reaching that state.
- **AUTO_REFUND_REVOCATION = NOT_AVAILABLE** under no-API/no-webhook. Stated honestly —
  not papered over (matches `FINAL_ZERO_ADMIN_PAYMENT_CURRENT_CAPABILITY_GATE.md`, OBJ 11).
- Subscriptions: intent lifecycle (PENDING→REVIEW→ACTIVE→GRACE→EXPIRED/REFUNDED/REVOKED/
  CHARGEBACK) and grace/auto-revoke sweeps exist and are safe; this is orthogonal to the
  correlation gap.

---

## 10. Test feasibility (how this could be verified without a live payment)

The correlation fact in §3 can be proven **without a real money transfer** using a
**no-money, read-only** mechanism, which prior docs noted was not yet permitted. Feasible
test options (all non-destructive, fail-closed, no code-documentation change):

1. **Origin/parse unit tests already cover** the collector, matcher, fraud, dedupe, and
   exactly-once paths (`payments-gmail-gate.test.ts`, `payments-26h.test.ts`,
   `gmail-claim.test.ts`). These pass today and are not the gap.
2. The **unverified gap** is external Razorpay email behavior (does the receipt echo the
   typed reference). That is best proven by a **single controlled, non-real-value/no-card**
   checkout read, or by inspecting a **Razorpay sandbox/test** confirmation email — both
   require Rails-side access that is not available in this audit and **no real money**.
3. A **dry/watchdog-drive** test (feed a synthetic, origin-passing, reference-bearing email)
   already exercises the full path to ACTIVE in the tests, confirming the engine is ready
   as soon as real reference-bearing receipts exist.

**So the remaining unknown is environmental (provider behavior + Gmail OAuth token
validity), not a code defect.**

---

## 11. Current configuration state (fail-closed, verified from local `.env`+defaults)

Checked against the repo `.env` and `env.ts` defaults:

| Variable | Current | Effect |
|----------|---------|--------|
| `GMAIL_CLAIM_ENABLED` | unset → `false` | Rail B disabled |
| `GMAIL_CLAIM_HMAC_SECRET` | unset | Rail B disabled (no HMAC key) |
| `GMAIL_OAUTH_ACCESS_TOKEN` / `GMAIL_OAUTH_REFRESH_TOKEN` (+`GOOGLE_CLIENT_ID`/`SECRET`) | unset locally | `gmailDetectorAvailable()` false → Rail A watchdog is a contained no-op |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | empty | API rail unavailable |
| `RAZORPAY_WEBHOOK_SECRET` | empty | Webhook rail unavailable |
| `RAZORPAY_MODE` | `payment_link` | checkout unchanged |

Everything is **fail-closed by default**; nothing is enabled implicitly. The local sandbox
has no payment rail enabled. Independent live-vars were noted present in prior docs for the
Railway **production** env only — not this repo, not verifiable here, values never printed.

---

## 12. Verdict

**Automatic zero-admin activation (no click, no admin, 24/7) is IMPLEMENTED and SAFE in
the engine (Rail A), and is FEASIBLE if and only if an authenticated Razorpay confirmation
email carries the exact user-typed reference.** That enabling fact is **UNVERIFIED** in this
audit (no live/no-money test permitted) and **cannot be proven from repo source**. Without
it, static-link receipts are reference-less and are correctly dropped, so intents stay
PENDING/REVIEW — the safe, honest default.

- Rail B (claim) is built and secure but is **not** automatic zero-admin (requires one
  customer click).
- No safe no-API/no-webhook workaround for multi-user static-link disambiguation exists.
- No admin activation surface exists (control center is read-only) — consistent with, and
  required by, the zero-admin goal.
- No code is changed; the trust boundary is unchanged (PASS).

---

## 13. Final gate block (exact)

```
# CODECONCLAVE PAYMENT ZERO-ADMIN FEASIBILITY GATE
AUDIT_TYPE                 = READ_ONLY_FEASIBILITY
NO_RAZORPAY_API            = YES
NO_RAZORPAY_WEBHOOK        = YES
NO_ADMIN_ACTIVATION        = YES   (control center is read-only; no activate/approve/force/grant)

RAIL_A_MAILBOX_WATCHDOG    = READY  (automatic, no-click, 24/7, idempotent, exactly-once, contained no-op when unconfigured)
RAIL_B_GMAIL_CLAIM         = READY  (secure one-time claim token; but REQUIRES a customer click -> NOT automatic zero-admin)

AUTO_ZERO_ADMIN_ENGINE     = READY_AND_SAFE
AUTO_ZERO_ADMIN_ENABLING   = CONDITIONAL   (requires auth'd receipt to carry exact user-typed reference)
REFERENCE_ECHO_IN_RECEIPT  = UNVERIFIED    (external Razorpay behavior; no live/no-money test permitted)
STATIC_MULTIUSER_NOREF     = FAIL          (reference-less static receipts dropped upstream; cannot disambiguate users)
TRUST_BOUNDARY             = PASS          (unchanged; gmail/api/webhook only -> ACTIVE; ocr/manual -> REVIEW only)
ENTITLEMENT_SAFETY         = PASS          (applyDecision sole ACTIVE gate; exactly-once; fraud-gated)
WATCHDOG_SECURITY          = PASS
24x7                       = STRUCTURALLY_SUPPORTED (in-process watchdog every 15s)
REFUND_DETECTION           = NOT_AVAILABLE (no API/webhook refund source; stated honestly)
ADMIN_ACTIVATION_SURFACE   = NONE          (no admin path exists; aligns with zero-admin goal)

CURRENT_LOCAL_RAILS        = DISABLED      (GMAIL_CLAIM/GMAIL_OAUTH/RAZORPAY_API/WEBHOOK all fail-closed)
REAL_PAYMENT               = NOT_PERFORMED
CODE_CHANGED               = 0
DEPLOYMENT                 = NOT_EXECUTED
FEATURES_REMOVED           = 0

PRIMARY_ANSWER = AUTOMATIC_ZERO_ADMIN_IS_FEASIBLE_IF_AND_ONLY_IF_REFERENCE_BEARING_RECEIPTS
                (engine complete + safe; enabling fact UNVERIFIED)
FAIL_SAFE      = NO_REFERENCE_STATIC_RECEIPTS_STAY_PENDING_REVIEW  (never auto-activate)
```

---

## 14. Stop

- No payment made.
- No admin activation created.
- No entitlement granted from unknown correlation.
- No Razorpay capability invented.
- No payment code modified.
- Current payment system stays in its safest, fail-closed state.

*Cross-refs: `FINAL_ZERO_ADMIN_PAYMENT_CURRENT_CAPABILITY_GATE.md`,
`FINAL_24_7_ZERO_ADMIN_PAYMENT_FEASIBILITY.md`, `FINAL_PAYMENT_ORCHESTRATOR_ARCHITECTURE.md`,
`FINAL_GMAIL_ZERO_ADMIN_LAUNCH_GATE.md`, `FINAL_CONDITIONAL_GMAIL_PAYMENT_SELF_SERVICE_GATE.md`,
`FINAL_ZERO_ADMIN_PAYMENT_RUNTIME_GATE.md`.*
