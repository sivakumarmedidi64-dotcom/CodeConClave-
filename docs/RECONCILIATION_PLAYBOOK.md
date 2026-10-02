# Payment Pool — Reconciliation Playbook (post-facto, human-only)

Status: operational guide · v1 · 2026

## Scope

This document tells a human operator how to **read** the immutable payment
ledger and decide what to do about money that arrived without a matching
entitlement. It is **post-facto and manual only**. The automated payment
rail never "heals" entitlements that did not meet the verification policy —
that is intentional (fail closed).

**Nothing in this playbook mutates `payment_intents`,
`payment_link_reservations`, entitlements, or evidence.** Those tables are
written exclusively by their owning modules (`intents.ts`, `pool/service.ts`,
`activation.ts` via the sole grant authority `applyDecision`, and the verified
evidence pipeline). A human operator who needs to grant, revoke, or refund uses
the existing, already-verified tooling (control-center, Gmail claim rail, or
refund flow) — never hand-written SQL against entitlement state.

## What the orphans ledger IS

`payment_pool_callbacks` is the append-only ledger of every callback outcome.
Each row stores:

| column            | meaning                                                   |
|-------------------|-----------------------------------------------------------|
| id                | callback id (`pcb-…`)                                      |
| link_index        | pool link the redirect targeted                            |
| payment_id        | Razorpay `razorpay_payment_id` (or generated `cb-…`)       |
| payment_link_id   | Razorpay payment link id                                   |
| reference_id      | immutable link reference echoed by callback               |
| link_status       | provider-submitted link status (`paid`/`attempted`/…)     |
| signature_sha     | **SHA-256 digest of the signature** — never the secret     |
| signature_valid   | whether the HMAC/token verified                            |
| outcome           | one of: `accepted`, `ambiguous`, `intent_plan_mismatch`,    `reservation_expired`, `orphaned`, `partial`, `invalid_signature`, `duplicate`, `forbidden` |
| reason            | free-text reason from the handler                          |

The raw Razorpay signature is **never** stored; only a digest. The watchtower
surfaces duplicates/invalid signatures as attack-traffic telemetry.

## When is a callback "orphaned"?

Razorpay supplied a payment-looking details bundle for a pool link, but the
backend could not bind it to a live reservation + intent. Causes:

1. Reservation expired / was reaped before the browser redirect arrived
   (late callback). The intent may still exist in `PENDING`.
2. `reference_id` from the provider did not match any configured pool link
   (operator typo in `PAYMENT_POOL_LINKS`, or a link paid that was removed).
3. A payer paid an inactive link directly (link `enabled=false` removed from
   the pool but still addressable on Razorpay).
4. Plan/amount mismatch (paid ₹999 for a link configured team, or vice-versa).
5. Signature invalid (forged/expired/attacker replay). Do NOT reconcile these
   as if they were real money.

Every one of the above is recorded as a callback row with the aggregate
outcome — nothing is silently dropped, and no entitlement is auto-granted.

## Step 1 — list orphans / ambiguous events

Only read-only SQL. Run from a DBA/`psql` session in **production**:

```sql
-- Money arrived, no entitlement, needs a human decision:
SELECT id, created_at, link_index, payment_id, reference_id, link_status,
       signature_valid, reason
  FROM payment_pool_callbacks
 WHERE outcome IN ('orphaned', 'ambiguous', 'reservation_expired',
                   'intent_plan_mismatch')
 ORDER BY created_at DESC
 LIMIT 200;
```

```sql
-- Suspicious traffic (do this first — these are NOT real-money events):
SELECT outcome, count(*) AS n
  FROM payment_pool_callbacks
 WHERE outcome IN ('invalid_signature', 'duplicate', 'forbidden')
 GROUP BY outcome;
```

```sql
-- Bolt the callback to the reservation history (if any reservation captured
-- the same payment_id):
SELECT r.id, r.link_index, r.intent_id, r.user_id, r.plan, r.status,
       r.payment_id, r.reserved_at, r.expires_at
  FROM payment_link_reservations r
  JOIN payment_pool_callbacks c ON c.payment_id = r.payment_id
 WHERE c.outcome IN ('orphaned', 'ambiguous');
```

## Step 2 — verify the money REALLY arrived (out-of-band)

The callback tells you Razorpay *intended* to mark a payment `paid`. Humans
must confirm in the Razorpay Dashboard (or the official Razorpay API, staff
credentials, out-of-band) that:

- `payment_id` exists on the provider and its amount/currency match the pool
  link's configured `amount`/`currency`;
- the credited account is the CodeConClave operating account (not a sandbox).

**Never** run this playbook against sandbox/demo payment ids collected in
stage; they are not real money and must not end up granting entitlements.

## Step 3 — the human decision tree (per orphan)

1. **Signature invalid?** Discard. Do not grant, do not refund. Record in the
   incident log; the watchtower already counts it.
2. **Payment verified, and a `PENDING` intent exists for the exact reference /
   reservation?** The entitlement can be completed through the EXISTING rails
   only — do **not** hand-insert activation rows:
   - Preferred: re-run the Gmail claim rail (Rail A) for that
     `reference`/`payment_id` if applicable (it validates plan/amount/dedupe
     server-side and issues a one-time claim token).
   - Or use the self-service/control-center activation paths already approved.
   The **same** verification invariants still apply: exact reference, exact
   amount/currency, expiry window, replay guard. A human bypasses NONE of
   them.
3. **Payment verified, but no intent matches (e.g. reservation expired and no
   other intent with that reference exists)?** Refund via the Razorpay
   Dashboard and record the refund in control-center (refund rail). Tell the
   customer to retry with a fresh checkout. This is the safe, honest outcome:
   the money goes back, no entitlement is fabricated.
4. **Plan/amount mismatch (paid the wrong link)?** Refund the wrong link and
   have the customer use the correct link (the pool seeder only seeds links
   whose amount equals the authoritative plan price, so this should be rare).

## Step 4 — audit the decision

Append to the incident log:

```text
date, callback_id(s), payment_id, decision (granted-via-<rail>/refunded/discarded),
authorized CP (human), reference to support ticket
```

Keep the callbacks ledger append-only. If a row's outcome was wrong, do not
UPDATE it — add a new `accepted`/still-`orphaned` row describing the follow-up.

## Guardrails

- **Read-only is the default.** Any write below belongs to its owning module
  (seeder / /pool service / activation / refund raft) — never ad-hoc.
- **Secret hygiene:** never log `signature`, HMAC secrets, Razorpay key ids, or
  full token material anywhere in this process. The ledger's `signature_sha`
  digest is all that is ever persisted.
- **PII:** payer emails and payment ids are already minimized in the ledger
  (payment ids echoed from Razorpay as-is). Do not copy emails into the
  playbook outputs; reference `user_id`/`cb…`/`pay…` ids only.
- **Escalation:** repeated orphan spikes (>3/day) should trigger a review of
  `PAYMENT_POOL_TTL_MINUTES` (too short for slow browsers), the
  `PAYMENT_POOL_LINKS` catalogue, and the callback redirect configuration.

## Relationship to the watchtower

The watchtower (`src/modules/payments/pool/watchtower.ts`) is the automated,
read-only *detector* that pages a human (via the globally-unscoped
`PAYMENT_WATCHTOWER_ALERT_EMAIL` alert destination) when it sees expired
reservations, over-subscription, unknown-link callbacks, replay/duplicate/
ambiguous evidence, or an empty pool. Without an alert address it still runs
every check and records the full report, emitting one
`ALERT_DESTINATION_UNCONFIGURED` warning. This playbook is the *response* to
those alerts. Neither the watchtower nor this playbook ever grants an
entitlement by itself.