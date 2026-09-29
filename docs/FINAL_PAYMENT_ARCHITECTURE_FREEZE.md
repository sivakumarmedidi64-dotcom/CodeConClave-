# CodeConClave — FINAL PAYMENT ARCHITECTURE FREEZE

> Date: 2026-08-31. Status: **FROZEN in a safe state.**
> No deploy, no payment, no code change, no secrets exposed.
> Decision: do not implement or deploy zero-admin automatic activation until the
> required Razorpay trusted server-side capability (signed webhook and/or API) is
> actually available.

---

## Frozen decision (truthful outcome)

```
CURRENT_ZERO_ADMIN = BLOCKED
REASON             = Razorpay trusted server-side capability unavailable
CURRENT_SECURITY   = PASS                     # only safe REVIEW/EVIDENCE paths
GMAIL              = REVIEW_AND_EVIDENCE_RAIL # evidence ui only; never auto-activates
STATIC_LINKS       = CHECKOUT_ONLY            # shared payment entities; never authority
OPTION_API         = DEFERRED                 # implementation exists; not enabled/deployed
OPTION_WEBHOOK     = DEFERRED                 # implementation exists; not enabled/deployed
OPTION_C           = FUTURE
OPTION_D           = FUTURE
ADMIN_ACTIVATION   = DISALLOWED               # MANUAL_ADMIN_NORMAL_PATH = NOT_ALLOWED
UNSAFE_WORKAROUNDS = DISALLOWED               # no static+email auto-activation, no payer-email anchor
MANUAL_ADMIN_NORMAL_PATH = NOT_ALLOWED_BY_PRODUCT_REQUIREMENT
```

Final feasibility result (unchanged, from the audit):
`NO_API_NO_WEBHOOK_NO_ADMIN_ZERO_ADMIN = NOT_POSSIBLE` with the current
static-link + Gmail configuration, because no trusted server-side value can bind a
static-link payment to exactly one CodeConClave user without Razorpay API/webhook.

---

## What the frozen architecture is (and is not)

Kept, working, and intact:

- **Gmail = trusted secondary / review rail** (`SAFE_REVIEW_RAIL`).
  - Authenticity proven via DKIM/SPF/DMARC bound to `razorpay.com` + From domain.
  - Normalized signals only; message contents never stored; idempotency/replay-guarded.
  - **Does not auto-activate from the static links** (no unique per-intent reference).
  - Serves as review/triangulation evidence, never sole authority.
- **Static links = checkout only** (`CHECKOUT_ONLY`).
  - PRO ₹999 `https://rzp.io/rzp/sAgHIpxS`, TEAM ₹4999 `https://rzp.io/rzp/3ioXlCxd`.
  - Used to let the customer pay; never used as an automatic-unlock authority.
- **Manual / OCR / user-submitted proof = REVIEW only**.
  - manual/OCR forced REVIEW, never ACTIVE (`pipeline.ts:66-78`).
  - client-supplied paymentId/reference/amount are never authority.
- **Redirect/callback = not payment proof** (`handleReturn` stays PENDING without API,
  `service.ts:292-306`).
- **Secure REVIEW fallback intact** — any payment that cannot be independently verified
  lands in REVIEW (requires human/provider confirmation), never grants access by default.

## Gmail limitation (documented, unchanged)

The live Gmail integration is a **review/evidence rail only** — it is explicitly
**not** an automatic-activation authority and **must never auto-activate** a
reference-less static-link payment. This is by design (trust boundary), not an omission:

- **REVIEW/EVIDENCE only.** Gmail provides verified (DKIM/SPF/DMARC-bound) signals for
  triangulation in REVIEW. It grants **nothing** automatically.
- **Never auto-activate reference-less static-link payments.** A static Payment Link is a
  single shared checkout entity (`plink_…`/`reference_id`/`short_url` identical for all
  customers), so a Gmail receipt has **no trusted per-user reference** to bind it to a
  specific CodeConClave intent/user without the Razorpay API/webhook. There is no
  deterministic `email → intent → user` mapping (`STATIC_MULTIUSER_CORRELATION = IMPOSSIBLE`).
- **Reference-less receipts stay PENDING / REVIEW.** Without a unique per-intent reference,
  the intent is never auto-activated; it remains PENDING or lands in REVIEW
  (`evidence.ts:247-260` authentic check; `evidence.ts:304-307` strict reference binding;
  `pipeline.ts:66-78` `effectiveMatch`; watchdog `sweepPendingIntentEvidence`
  `service.ts:602-628` reuses the exact-reference pipeline — reference-less receipts are
  dropped upstream and remain non-activating).
- **Manual / OCR / user-submitted proof = forced REVIEW**, never ACTIVE
  (`pipeline.ts:66-78`).
- No real payment is auto-activated through the static-link path; the secure REVIEW
  fallback stays intact.

## Frozen constraints (do-nots)

1. NO insecure workaround for zero-admin activation.
2. NO static-link + Gmail as automatic-entitlement authority.
3. NO payer email as the primary correlation anchor (signal only).
4. NO redirect/callback as payment proof.
5. NO trust of client-submitted paymentId/reference/amount.
6. NO manual approval added to the normal successful-payment path
   (`MANUAL_ADMIN_NORMAL_PATH = NOT_ALLOWED_BY_PRODUCT_REQUIREMENT`).
7. NO real payment through the current static-link path expecting automatic unlock.
8. NO redesign of the existing payment architecture.
9. NO deployment of payment-related changes.
10. Keep the current secure REVIEW fallback intact.

---

## Future target (NOT implemented now)

- **OPTION_C = FUTURE** — signed Razorpay webhook auto-activation.
- **OPTION_D = FUTURE** — signed webhook + Razorpay API reconciliation.

The per-intent reference + signed-webhook + API architecture is **already implemented and
handler-level tested** (`createRazorpayPaymentLinkForIntent`, signed webhook route, amount/
plan/idempotency/intent-binding), but it will **not be enabled or deployed** until the
required Razorpay trusted capability (API key/secret and/or webhook secret + dashboard
registration) is actually available and approved.

---

## Freeze scope

- Payment implementation is frozen in this safe state.
- No unrelated modules are modified.
- No secrets are exposed (credential/setup steps remain human-gated and approval-gated).

---

## References
- `docs/FINAL_ZERO_ADMIN_NO_API_NO_WEBHOOK_FEASIBILITY.md` — feasibility audit (NOT_POSSIBLE).
- `docs/FINAL_ZERO_ADMIN_PAYMENT_DESIGN_DECISION.md` — option ranking (rec. final D).
- `docs/FINAL_ZERO_ADMIN_PAYMENT_ACCEPTANCE_TEST.md` — controlled-test blocker record.
- `docs/FINAL_GMAIL_ZERO_ADMIN_LAUNCH_GATE.md` — Gmail rail verification (READY rail, BLOCKED zero-admin).
