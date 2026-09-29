# ZERO-ADMIN PAYMENT ROADMAP — CodeConClave

Release/operations roadmap for moving from the current zero-admin payment
**blocked** state to a trusted zero-admin payment verification path.
**Nothing here is implemented until trusted provider access exists.** This is
planning only — no source changes, no deploy, no bypass of Razorpay
restrictions, no enabling of insecure manual activation.

Current live payment status:
- `ZERO_ADMIN_PAYMENT = BLOCKED_BY_RAZORPAY` (per production freeze).
- `razorpayConfigured = false` → capability reports `payment-link mode`.
- No `RAZORPAY_*` vars present in either service environment (verified by name-only scan).
- Sessions stay `PENDING` until provider confirmation (server-authoritative).
- UI is truthful: `HomePage.tsx` = "Payment pending verification — your plan activates once the provider confirms."; `SettingsPage.tsx` = sessions stay PENDING until the payment provider confirms; capability line shows `payment-link mode`. No false "automatic activation guaranteed" is shown.

## CURRENT (today)
- **Gmail evidence rail** (human/email-based evidence path) — not automated reconciliation.
- **Static payment links** — configured, but activation is not zero-admin.
- **No automatic safe user correlation** — no trusted way to map a payer to an account without risk.

Because there is no automatic, safe, trusted payer→account correlation, payment
activation must **not** be represented as zero-admin. First-customer paid launch
requires either a human-verification support process or a trusted provider path.

## NEXT — trusted server-side capability (preferred)
- Obtain **Razorpay account-level API credentials** (Razorpay `API` mode): the
  existing `createRazorpayPaymentLinkForIntent` is gated on `RAZORPAY_API` creds
  which are absent. With API creds + server-side webhook verification + a
  signed/verified event, zero-admin activation becomes trustworthy and safe.
- This gives automatic, safe correlation (the provider's own payment object /
  order references map deterministically to the CodeConClave intent/session).

## OPTION C — Signed webhook (webhook-only zero-admin, no read API)
- Enable Razorpay **webhooks** using an existing `WEBHOOK_SECRET` (signature-verified
  payloads) to receive `payment.captured` events.
- Requires a webhook secret already configured and a reachable HTTPS webhook
  endpoint. Provides trusted server-side confirmation with no outbound API reads.
- Do not implement until a secure signed-webhook target + secret exist.

## OPTION D — API + signed webhook (full zero-admin)
- Razorpay **API** (server-side create/verify payment links/orders) **plus** a
  signed webhook — the most robust zero-admin path: create intent server-side,
  capture the authoritative payment/order ID, verify via API and/or signed
  webhook, then flip entitlement to `PRO_VERIFIED` automatically.
- Do not implement until Razorpay API credentials + webhook secret are provisioned.

## Decision gate
- **Do not implement C or D, and do not enable insecure manual activation,
  until provider access exists** (i.e., credentials provisioned and the webhook
  endpoint + secret are secured).
- Until then: payment automation = **NOT AVAILABLE YET** (see
  CUSTOMER COMMUNICATION in the launch gate). Customers must not be led to
  believe activation is instant/zero-admin.

## Success criteria (future)
1. Trusted provider verification live (API and/or signed webhook).
2. Entitlement flips `PRO_VERIFIED` only on verified provider confirmation.
3. Zero human review for the happy path.
4. UI remains truthful about PENDING until verification.
