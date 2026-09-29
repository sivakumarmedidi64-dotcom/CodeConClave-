# AUTOMATIC PAYMENT ACTIVATION REPORT

CodeConClave — Pro/Team payments: **fully automatic activation** via the Razorpay
**Payment Link checkout → signed webhook verification** rail, with no manual admin
click required and the founder able to be offline. The manual/OCR review boundary is
preserved — nothing a customer fabricates can auto-activate.

---

## 1. What this report is

Implementation + verification status for **server-created unique Razorpay Payment
Links per payment intent**, **signed-webhook automatic entitlement activation**, and
the surrounding security invariants (idempotency, replay protection, identity binding,
plan/amount authority, audit/reconciliation). **DEPLOYMENT: BLOCKED** — no deploy, no
`railway up`, no real payment, no push.

## 2. The checkout + verification rail (as built)

```
User selects plan
  -> backend createPaymentIntent(user, plan)            [26H intent, status PENDING]
  -> backend creates a UNIQUE Razorpay Payment Link via
       POST https://api.razorpay.com/v1/payment_links    [RAZORPAY_KEY_ID/SECRET]
       amount = plan paise (Pro 99900 / Team 499900), currency INR,
       reference_id = intent.reference (unique CCREF),
       notes = { intent_id, plan } (no sensitive data),
       callback_url = API_URL/api/v1/payments/status
  -> stores on payment_intents:
       payment_link            = short_url (unique)
       provider_payment_link_id = Razorpay link id (plink_..., unique)
       provider_reference_id    = reference_id (unique)
  -> customer pays via the short URL
  -> Razorpay POSTs /api/v1/payments/webhook/razorpay (signed)
  -> backend:
       raw-body HMAC-SHA256 signature check (RAZORPAY_WEBHOOK_SECRET)
       event-level idempotency (payment_webhook_events keyed by event.id)
       resolve exact intent by provider_reference_id / provider_payment_link_id /
       internal reference — NEVER by email alone
       plan + amount validation vs the server map (Pro 999, Team 4999 INR)
       route through the trusted 26H pipeline (razorpay_webhook source)
       -> ACTIVE + entitlement (exactly-once, race-guarded)
  -> audit + payment.status/PRO_VERIFIED notification
```

- Static per-plan links
  (`https://rzp.io/rzp/sAgHIpxS` Pro ₹999, `https://rzp.io/rzp/3ioXlCxd` Team ₹4999)
  remain as **checkout/fallback**: kept in the contact/payment-info copy and used when
  the Payment Link API is unavailable. Because they carry **no per-user reference** in
  webhook payloads, payments made on them cannot be bound to a user — they land in
  REVIEW/PENDING and are matched manually (never auto-activate). This satisfies the
  mandate: *a normal user payment auto-activates; a payment that cannot be bound does
  not auto-activate*.

## 3. Trusted verification sources (order of preference)

| Rail | Uses | Trusted to activate |
| --- | --- | --- |
| A. Signed Razorpay **webhook** | payment.captured / payment_link.paid, HMAC-verified | YES (auto) |
| B. Razorpay **API** (query only, live creds) | razorpay_api source, provider payment id + amount | YES (when creds present) |
| C. **Gmail** transaction receipt | payer email + amount + reference | YES (when OAuth + account configured) |
| Manual / OCR screenshot | untrusted, user-asserted | NO — forced REVIEW (`manual_assertion_cannot_activate`) |

## 4. Environment variables required for AUTO-ACTIVATION

> Names only — values never appear in this repo or this report.

| Env var | Required for auto-activation |
| --- | --- |
| `RAZORPAY_KEY_ID` | YES — server-side creation of unique Payment Links |
| `RAZORPAY_KEY_SECRET` | YES — server-side auth for the Payment Links API |
| `RAZORPAY_WEBHOOK_SECRET` | YES — trusted webhook signature verification |
| `RAZORPAY_WEBHOOK_ENABLED` | YES — must be `true` to accept the webhook rail |

Without `RAZORPAY_WEBHOOK_ENABLED=true` + `RAZORPAY_WEBHOOK_SECRET`, the webhook route
is unavailable and the system falls back to API/Gmail/REVIEW provisioning (manual
activation). Checkout (Payment Links) keeps working in every mode because the webhook
is the **verification rail**, not the checkout method.

## 5. Security model (unchanged / reinforced)

- A customer can **never self-verify**: no client-supplied paymentId/amount/reference/
  screenshot/manual assertion can produce VERIFIED/ACTIVE.
- Signature verification over the **raw body bytes** (timing-safe HMAC-SHA256) using
  the raw-body parser mounted before the global JSON parser.
- Trusted resolution keyed on **server-authoritative identifiers** stored at intent
  creation (per-intent link id + reference_id), not on email.
- Plan/amount validated against the server map; mismatch → REVIEW + audit, no
  activation. `amount_mismatch` and `plan_mismatch` are blocking fraud flags.
- Idempotency at two layers: `payment_webhook_events` (event.id) and unique sha /
  provider-payment uniqueness; the ACTIVE transition is a conditional UPDATE
  (race-safe, exactly-once entitlement).
- Replay protection: same event.id, same provider payment id, same evidence sha across
  intents are all rejected/deduped.
- Tenant isolation: intent resolution + pipeline always owner-scoped; cross-user
  evidence ingestion is rejected.
- Audit: every webhook event (processed, signature-invalid, amount mismatch,
  unmatched, refunded) is appended to `audit_logs`. Reconciliation remains report-only
  (`COMPLETED_WITH_DRIFT` when an ACTIVE intent lacks an entitlement).

## 6. What changed

| File | Change |
| --- | --- |
| `backend/src/config/env.ts` | Added `RAZORPAY_WEBHOOK_ENABLED` (default `false`), decoupling the webhook verification rail from checkout `RAZORPAY_MODE`. |
| `database/migrations/0056_stage26h_payment_link_binding.sql` | NEW — `provider_payment_link_id` / `provider_reference_id` (unique where not null) on `payment_intents`; `payment_webhook_events` (event.id PK) idempotency table. Static-only validation in this environment. |
| `backend/src/modules/payments/service.ts` | `createRazorpayPaymentLinkForIntent` — server-side API call to create a unique Payment Link per intent (Pro 99900 / Team 499900 paise, INR, reference_id, notes, callback). Returns null when API unavailable. |
| `backend/src/modules/payments/intents.ts` | `createPaymentIntent` now stores the unique link + `provider_payment_link_id` + `provider_reference_id`; falls back to the static per-plan link when the API is unavailable. |
| `backend/src/modules/payments/routes.ts` | Webhook handler rewritten: enabled by webhook flag (not mode); raw-buffer signature check; event.id idempotency; intent resolution by provider reference/link/CC reference; plan+amount validation; trusted `razorpay_webhook` pipeline activation; refund handling (`payment.refunded`). Unresolvable/mismatched events are recorded and never auto-activate. |
| `backend/src/app.ts` | `express.raw` mounted for `/api/v1/payments/webhook` **before** the global JSON parser so the handler receives the exact signed bytes. |
| `backend/src/modules/payments/evidence.ts` | `webhookDetectorAvailable()` now gated on `RAZORPAY_WEBHOOK_ENABLED` + secret; webhook collector also reads `payment_link.entity.reference_id`. |

## 7. Files NOT changed

- `backend/src/modules/payments/activation.ts` — existing `applyDecision` / refund /
  revoke / chargeback / `activateEntitlement` reused as-is (auto-activation rides the
  existing 26H race-safe path).
- `backend/src/modules/payments/pipeline.ts` — existing `ingestEvidence` / trusted-source
  gating / replay guard reused.
- `backend/src/modules/payments/matcher.ts`, `fraud.ts`, `reconciliation.ts`,
  `digest.ts`, `receipts.ts` — unchanged.
- `frontend/`, `local-agent/`, `shared/` — unchanged (only type support via shared build,
  which recompiles cleanly).

## 8. Test results

- `backend/src/foundation/payments-26h.test.ts` — **64 tests PASS** (52 prior + 12 new
  webhook/unique-link rail tests).
- `backend/src/foundation/payments-4d.test.ts` — **28 tests PASS** (webhook capability
  detection updated to the new flag; API/amount/session authority unchanged).
- Backend full suite: **1755–1758 passed**, 3 skipped, only the two pre-existing,
  documented timing flakes can fail (`perf-17` pipeline smoke >target; `integration-17`
  memory+DNA 15s timeout) — both unrelated to payments, files unmodified.
- Shared **63 PASS**, local-agent **49 PASS**, frontend **279 PASS**.
- `npm run build` (shared → backend → local-agent) and `npm run typecheck` — **PASS**.

### 17 acceptance-style checks (mapping to real tests)

| # | Requirement | Test (file: name) | Result |
| --- | --- | --- | --- |
| 1 | Valid **Pro** webhook auto-activates | payments-26h: "a valid signed webhook auto-activates Pro -> ACTIVE with an entitlement" | PASS |
| 2 | **Team** priced correctly / team link | payments-26h: "TEAM resolves to the ₹4999 amount and TEAM payment link", "TEAM never falls back to the PRO ₹999 link" | PASS |
| 3 | Invalid signature rejected | payments-26h: "rejects an invalid signature" | PASS |
| 4 | Wrong amount rejected (no activation) | payments-26h: "a webhook whose amount does not match the intent never auto-activates nor grants" | PASS |
| 5 | Wrong plan rejected | payments-26h: "plan_mismatch blocks TEAM-intent evidence with a PRO reference", "PRO intent + TEAM ₹4999 amount is rejected" | PASS |
| 6 | Fabricated paymentId cannot activate | payments-26h: "fabricated manual paymentId alone cannot activate", "a fabricated manual assertion (paymentId/reference/amount) can NEVER activate" | PASS |
| 7 | Fabricated reference cannot activate | payments-26h: "fabricated manual reference alone cannot activate" | PASS |
| 8 | Client manual assertion can never activate (webhook flag on) | payments-26h: "fabricated/manual evidence can never activate even when the webhook flag is on" | PASS |
| 9 | Replayed event.id idempotent | payments-26h: "a replayed event.id is idempotent (no double the entitlement grant)" | PASS |
| 10 | Duplicate payment id idempotent | payments-26h: "duplicate payment id across intents is blocked -> REVIEW", "the same evidence sha256 against a different intent is rejected as replay" | PASS |
| 11 | Unresolvable webhook → recorded, never activated | payments-26h: "a webhook that resolves to no intent is recorded, never auto-activated" | PASS |
| 12 | Refund revokes | payments-26h: "a webhook refund sets the intent to REFUNDED and revokes the entitlement" (webhook), "refunds an ACTIVE intent: entitlement PRO_REFUNDED, plan free" (pipeline) | PASS |
| 13 | Cancellation / non-payment events do not activate | payments-26h: expiry/GRACE/revoke tests; handler records lifecycle events as no-ops | PASS |
| 14 | Tenant isolation (cross-user ingest rejected) | payments-26h: "another user cannot ingest evidence into someone else's intent", "intent lookups always filter by owner id (cross-tenant safe)" | PASS |
| 15 | Audit trail for webhook events | payments-26h: `recordAudit` asserted on `payment.webhook_processed` / `payment.webhook_signature_invalid` / `payment.webhook_amount_mismatch` / `payment.webhook_unmatched` / `payment.webhook_refunded` | PASS |
| 16 | Reconciliation drift reported, not auto-fixed | payments-26h: "reports ACTIVE intents without an entitlement as drift (no auto-fix)" | PASS |
| 17 | Misconfiguration shuts the rail down | payments-26h: "RAZORPAY_WEBHOOK_ENABLED off -> webhook route is unavailable (404), no processing"; payments-4d: "enables the webhook detector only when secret AND the webhook verification rail are set" | PASS |

## 9. Deployment posture

- **DEPLOYMENT: BLOCKED.** This session intentionally did NOT deploy, did not run
  `railway up`, did not make a real Razorpay payment, and did not push.
- Required at deploy time (outside this environment): set `RAZORPAY_WEBHOOK_ENABLED`
  (true), `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`; register
  the webhook URL `https://<app>/api/v1/payments/webhook/razorpay` for
  `payment.captured` / `payment_link.paid` / `payment.refunded` in the Razorpay
  dashboard; run `0056_stage26h_payment_link_binding.sql` in the database migration
  sequence before enabling auto-activation.
- Live end-to-end (real Razorpay link creation + real webhook delivery) is **BLOCKED**
  here because no real provider credentials exist in this environment; covered by
  mocked unit tests above.

## 10. Manual admin requirement

**NO** — when the webhook rail is enabled and signed events arrive with an unambiguous
intent match, the entitlement is granted automatically and the founder can be offline.
Manual admin review remains required ONLY for:
- payments on the static per-plan links (no per-user binding),
- unmatched/replayed/amount-mismatched/plan-mismatched webhooks,
- OCR/manual evidence (always REVIEW by design).