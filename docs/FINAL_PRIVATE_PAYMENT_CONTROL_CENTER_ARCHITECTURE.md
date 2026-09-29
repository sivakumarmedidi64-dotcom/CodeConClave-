# FINAL — PRIVATE PAYMENT CONTROL CENTER ARCHITECTURE

**Design-only. Reuse the existing `payments/` subsystem; do NOT build a
duplicate.** This is the target architecture for CodeConClave's private payment
evidence + correlation + entitlement control system. It is the same subsystem
already in production, expressed as the control-center, plus the three additive,
non-security surfaces (Founder Dashboard, Sheet mirror, country metadata).

---

## 1. Component architecture

```
                        ┌──────────────────────────────────────────────┐
                        │          PAYMENT CONTROL CENTER              │
                        │        (backend/src/modules/payments)        │
                        │                                              │
   static PRO/TEAM link │  ┌────────────────────────────────────────┐  │
   ─────────── Razorpay │  │ Intent Registry   │intents.ts│         │  │
   Gmail watchdog ──────┼─▶│ Evidence Collector│evidence.ts│        │  │
   Apps Script ────────▶│  │ Correlation Engine│matcher.ts│         │  │
                        │  │ Verification      │pipeline.ts│        │  │
                        │  │ Risk/Fraud        │fraud.ts│           │  │
                        │  │ Idempotency Ledger│(unique+dedupe)     │  │
                        │  │ Entitlement Engine│activation.ts│      │  │
                        │  │ Refund Monitor    │(dormant webhook)   │  │
                        │  │ Reconciliation    │reconciliation.ts│  │  │
                        │  └────────────────────────────────────────┘  │
                        │                                              │
                        │  Additive (flag-gated, non-security):        │
                        │   ┌────────────────────────────────────────┐ │
                        │   │ Founder Dashboard  (read-only, private)│ │
                        │   │ Google Sheet Mirror (audit only)       │ │
                        │   │ country metadata (intent record)       │ │
                        │   └────────────────────────────────────────┘ │
                        └──────────────────────────────────────────────┘
                                     │  authority (single ACTIVE gate)
                                     ▼
                         Identities & Entitlements (db) ── audit trail
```

## 2. Data flow (unchanged security semantics)

1. Authenticated user selects PRO (₹999) / TEAM (₹4999).
2. Backend creates a **pending intent** with a **unique reference**
   (`CCPRO-XXXXXX` / `CCTEAM-XXXXXX`) + optional `country` metadata.
3. Customer **copies the reference** into the static Razorpay link checkout and
   pays.
4. Gmail watchdog / Apps Script (**collector only**) detects the candidate
   receipt, parses candidate evidence, signatures the payload, dedupes, retries,
   and POSTs to the backend — it never activates.
5. Backend **verifies**: origin-authentication (DKIM/SPF/DMARC + razorpay.com),
   exact reference, plan, exact amount, payment status, timestamp/window, payment
   ID, duplicate/replay, pending intent state.
6. **Correlation**: only exact-reference, origin-authenticated signals are
   released. Reference-less receipts (shared static link) are **dropped**.
7. If safe → authoritative `applyDecision` transitions PENDING → ACTIVE (sole
   gate). Uncertain → PENDING / REVIEW / UNKNOWN (auto-activation is forbidden on
   uncertainty).
8. Idempotency Ledger + audit record; optional Sheet mirror (**audit only**) and
   Founder Dashboard (**read-only**) reflect the state.

## 3. Trusted evidence model

| Evidence | Obtained | Authority |
|---|---|---|
| payment_id | origin-authenticated receipt (`pay_…`) | correlation + dedupe key |
| payment_link_id | shared static links: NOT per-user | — |
| provider_reference_id | 0056 columns; only when per-customer link bound | provider-bound when present |
| reference | customer-typed + echoed in receipt | conditional correlation |
| amount / currency / method / status / timestamp | receipt text | verification |
| payer_email | receipt text (sender/merchant) | NOT proof of payer |

## 4. Auto-unlock (exact rule)

```
TRUSTED_PAYMENT_EVIDENCE ∧ EXACT_USER_CORRELATION ∧ CORRECT_PLAN
  ∧ CORRECT_AMOUNT ∧ IDEMPOTENCY_PASS ∧ FRAUD/REPLAY_PASS
  ⇒ ACTIVE
else ⇒ PENDING / REVIEW / UNKNOWN
```

Nothing client-derived (redirect, localStorage, sessionStorage, user-typed ID,
screenshot, forwarded receipt, Sheet row, "I paid", email ownership alone) is
authority.

## 5. Bounded roles

- **Apps Script:** COLLECTOR / WATCHDOG / TRANSPORT — scan, parse candidate,
  sign, dedupe, retry, forward. Never activates.
- **Google Sheet:** AUDIT / REPORTING / LEDGER. Columns as specified; no secrets;
  never authorization source.
- **Founder Dashboard:** private read-only — TODAY aggregates + payments table.
  Founder-only auth; no write path; no secrets.

## 6. Idempotency / refund

- DB unique constraint on provider payment id (one payment ≠ two accounts);
  `signalSha256` dedupe; `applyDecision` exactly-once conditional UPDATE.
- `AUTO_REFUND_REVOCATION = NOT_AVAILABLE` under no-API/no-webhook. Upgrade path:
  enable Razorpay webhook (`payment.refunded`) → correlation becomes
  provider-bound and refund revocation becomes available.

## 7. Additive scope (only if approved, flag-gated)

1. **Founder Dashboard** — read-only page (frontend) + read endpoints over
   `reconciliation.ts` / `payment_intents`; founder-only.
2. **Google Sheet mirror** — Apps Script writes the audit ledger (audit-only).
3. **`country` metadata** — optional additive column on the intent/customer
   record; metadata only, never proof.
4. Flag: reuse `AIOS_PAYMENT_SELF_SERVICE` (or a new `PAYMENT_CONTROL_*`) — OFF.

## 8. No change

No deployment, no real payment, no Railway/Neon/migration, no production payment
config change, no new activation authority. `FEATURES_REMOVED = 0`.
