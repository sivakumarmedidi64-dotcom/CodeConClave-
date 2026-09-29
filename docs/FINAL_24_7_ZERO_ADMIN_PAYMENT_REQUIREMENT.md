# CodeConClave — FINAL 24/7 ZERO-ADMIN PAYMENT REQUIREMENT

> Date: 2026-08-31.

## Final product requirement (non-negotiable)
- 24/7 operation
- automatic entitlement activation
- zero admin work after payment
- secure/trustworthy verification
- user-friendly payment experience

## Final current provider constraints
- NO Razorpay API
- NO Razorpay webhook
- NO admin activation

## Conclusive finding (from the feasibility audit)
`NO_API + NO_WEBHOOK + NO_ADMIN + STATIC_RAZORPAY_LINK = NOT POSSIBLE` for trustworthy
automatic per-user activation, because a static Payment Link is a single shared checkout
entity (fixed `plink_…` / `reference_id` / `short_url` for all customers) and carries no
per-intent value the CodeConClave backend pre-recorded. No safe workaround exists.

## Explicit do-nots (trust boundary protected)
- DO NOT trust payer email as the identity anchor
- DO NOT trust redirect parameters
- DO NOT trust screenshots
- DO NOT trust client-provided payment IDs
- DO NOT trust client-provided references
- DO NOT auto-activate reference-less Gmail receipts
- DO NOT automatically activate REVIEW evidence
- DO NOT weaken the trust boundary

## Current safe state (kept intact)
- static payment links = checkout only
- Gmail = trusted evidence / review rail
- reference-less payments = REVIEW / PENDING
- manual / OCR evidence = never ACTIVE
- client = never entitlement authority

## Record
```
CURRENT_CONSTRAINTS          = NO_API + NO_WEBHOOK + NO_ADMIN
CURRENT_AUTO_UNLOCK          = NOT_POSSIBLE
CURRENT_SECURITY             = PASS
CURRENT_PAYMENT_STATE        = FROZEN_SAFE
FUTURE_MINIMUM_CAPABILITY    = SIGNED_RAZORPAY_WEBHOOK OR API-CREATED PER-INTENT PAYMENT LINK
FUTURE_ZERO_ADMIN            = READY_TO_ENABLE_WHEN_PROVIDER_CAPABILITY_AVAILABLE
DEPLOYMENT                   = BLOCKED_FOR_PAYMENT_AUTOMATION_ONLY
```

## Stop
- No payment made.
- No deployment.
- No payment code modified.
- Current payment system remains in its safest state.
