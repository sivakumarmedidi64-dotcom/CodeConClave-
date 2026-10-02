# CODECONCLAVE — LIVE PAYMENT INCIDENT (2026-09-06)

**Date (investigation):** 2026-09-08
**Severity:** HIGH (paid customer left on the free plan)
**Repository:** `C:\Users\sride\CodeConClave-`
**Scope:** payments only — no new engine, no user-data writes, no migration, no deploy.

---

## Incident summary

The founder paid for the pro plan via the checkout on **Sunday 2026-09-06** and
confirmed funds on their bank account on **Tuesday 2026-09-08**. The account
remained on `plan_id = free` with no entitlement: **no code path activated the
plan because the payment never produced system-verifiable evidence.**

This report documents the end-to-end trace, the DB/configuration facts, the
root-cause classification, the (single) latent code defect found and fixed, the
deterministic E2E test now proving the auto-unlock chain, and the decision that
**no account repair write is justified**.

---

## Tenant / table inventory (real DB, read-only snapshot)

Database: Neon `neondb`. Inspection ran under `BEGIN TRANSACTION READ ONLY`.
Snapshot: `C:\Users\sride\AppData\Local\Temp\opencode\incident-db-snapshot.json`.

| table | count | notes |
|---|---|---|
| `payment_link_pool` | 50 | ALL placeholders (`razorpay_url = http://localhost:4000/cb/N`, `razorpay_url` pay=impossible, `payment_link_id = NULL`, `reference_id = CCPOOL-001..050`) |
| `payment_link_reservations` | 3 | ALL `EXPIRED`, none fulfilled, `payment_id = NULL` |
| `payment_pool_callbacks` | 0 | no callback ever arrived at `/cb/:linkIndex` |
| `payment_intents` | 2 | both `EXPIRED` (swept), `confidence = 0`, `decision = NULL` |
| `payment_evidence` | 0 | no evidence ever ingested |
| `payment_reconciliations` / `payment_webhook_events` / `payment_claims` / `payment_sessions` / `payments` | 0 | |
| `entitlements` | 3 | probe-users only, none for the founder |
| `payment_audit` | 0 | |

Affected user: `usr_a6sznusr5jgxbnt54o60` (email masked `s..@gmail.com`),
`plan_id = free`, created 2026-09-05T17:35:01Z.

## Timeline (all UTC)

| when | event |
|---|---|
| 2026-09-05T13:13Z | seeder creates 50 placeholder pool links |
| 2026-09-05T17:35Z | founder account created |
| 2026-09-06T05:31Z | pro intent + reservation (link 1) → auto-expired 05:46 |
| 2026-09-06T08:17Z | pro intent re-reserved (link 1) → auto-expired 08:32 |
| 2026-09-06T12:41Z | team intent + reservation (link 3) → auto-expired 12:56 |
| 2026-09-07T13:06Z | intent-expiry sweep marks both intents `EXPIRED` |
| 2026-09-08 | founder confirms payment on their bank; account still `free` |

The pool watchtower correctly expired stale reservations within the ~15 min
TTL. The system failed **closed**, never granting an entitlement without
verifiable evidence — exactly as designed. There was also **no ghost write**:
no direct `users.plan` mutation happened or is justified.

## Deployment configuration facts (from `.env`, values withheld)

| variable | state |
|---|---|
| `RAZORPAY_MODE` | `payment_link` |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | empty (len 0) → API rail off, `apiDetectorAvailable()=false` |
| `RAZORPAY_WEBHOOK_SECRET` / `RAZORPAY_WEBHOOK_ENABLED` | unset → webhook rail off |
| `GMAIL_OAUTH_*` / `PAYMENT_ACCOUNT_EMAIL` | unset → gmail rail off |
| `PAYMENT_POOL_LINKS` | unset → pool is placeholder-only (non-explicit) |
| `RAZORPAY_PRO_PAYMENT_LINK` / `RAZORPAY_TEAM_PAYMENT_LINK` | static per-plan links (reference-less) |

Checkout flow (`intents.ts` → attempt real Razorpay link, fall back to
`paymentLinkForPlan`): with no API creds, the intent carried the **static
per-plan link** and `bindResultForIntent` returned `paymentUrl = intent.payment_link`
because the pool is non-explicit. That shared link carries **no intent-bound
reference**, so **no configured rail could ever observe or attribute the
payment** — not the pool callback (browser never redirected through `/cb/N`),
not the webhook, not the API, not gmail.

## Root cause

**Classification G/H:** the payment was observed outside the system
(`PAYMENT_OBSERVED_OUTSIDE_SYSTEM = YES` — founder/bank confirmation) with
**no system-verifiable evidence** (`SYSTEM_VERIFIABLE_EVIDENCE = NO`). Evidence
never entered any activation rail:

1. No provider rails configured (API/webhook/gmail credentials all absent).
2. Pool seeded with placeholders only → checkout handed out reference-less
   static links.
3. **Latent code defect (fixed):** `verifyPoolSignature` signed/verified the
   message `reference_id:payment_id`. Razorpay's real payment-link browser
   redirect signs `payment_id|payment_link_id|reference_id|status` (HMAC-SHA256,
   `RAZORPAY_KEY_SECRET`). Even with real pool links provisioned, every
   authentic callback would fail `invalid_signature` and be **permanently**
   ledged non-activating (dedupe by `payment_id` is terminal) — a second, silent
   blocker for auto-activation on this rail.

Auto-activation correctly failed closed in the field; the failure is the
**absence of a configured, correctly-seaming evidence rail**, not a bypass or
an incorrect grant.

## Decision: no account repair write

Granting an entitlement would route through `applyDecision` (the sole grant
authority). The requirements are evidence on the intent; there is **none**
(`payment_evidence = 0`, callbacks `0`). A "repair" write for the founder's
report alone would violate the incident rules (never respond to claims alone,
never invent evidence, never touch `users.plan` directly). **No write was
performed**, and the decision cannot be reversed by code alone: the operator
must either (a) provide verifiable provider evidence (payment id linked to the
founder's intent) so the pipeline can activate, or (b) refund/cred-pack the
founder outside the activation rail. That is an operator decision.

## Code fix (minimal, payment-only)

- `backend/src/modules/payments/pool/callback.ts` — `verifyPoolSignature` now
  verifies the provider-AUTHENTIC Razorpay payment-link redirect signature
  (`payment_id|payment_link_id|reference_id|status`, HMAC-SHA256 with
  `RAZORPAY_KEY_SECRET`) FIRST, and keeps the legacy in-repo scheme
  (`reference_id:payment_id`) as a compatibility fallback. Both require the
  same secret, so no authenticity weakening.
- `backend/src/modules/payments/pool/service.ts` — `verifyCallbackSignature`
  docstring updated to the two supported messages.
- `backend/src/modules/payments/pool/auto-unlock.test.ts` — deterministic,
  DB-mocked, no-network E2E of the incident fix: reserve → **authentic**
  Razorpay redirect callback → pool binding → trusted pipeline →
  `applyDecision` → entitlement `PRO_VERIFIED` + `users.plan_id` +
  reservation `FULFILLED` + callback ledger `accepted`; fail-closed checks for
  wrong secret, late/expired reservation, replay; legacy-scheme compat.
- `.secret-scan-allowlist.json` — fixture entry for the fake test secret
  (same sanctioned nature as `pool.test.ts` / `prove-payment.test.ts`).

## Verification

| gate | result |
|---|---|
| Payment regression (10 files, incl. new E2E) | **143/143 passed** |
| Legacy payment suites (unchanged expectations) | 138/138 green (baseline unaffected) |
| Secret scan (`secret-scan.test.ts`, repo surface) | 848 files, **0 findings** |
| Typecheck (`tsc --noEmit`) | OK |
| Build (`tsc emit`) | OK |
| Migrations | ALL APPLIED (73/0) — **no new migration added** |

Known test-infra note: `control-center.test.ts` router test uses the default
5 s import timeout, which can trip under heavy concurrent batch transform load
(it passes solo; the 9 legacy files pass together; the 10-file batch passes with
`--testTimeout=20000`). This is a pre-existing load sensitivity, not a code
regression.

## Required operator remediation (to enable future auto-activation)

1. Create real Razorpay payment links with `callback_url = https://<host>/cb/N`
   and unique per-link `reference_id`; set `PAYMENT_POOL_LINKS` (explicit pool)
   → `payment_link_id`, reference and razorpay_url become real; placeholders
   must be replaced, not layered.
2. Set `RAZORPAY_KEY_SECRET` (and `RAZORPAY_KEY_ID` if using the API rail).
3. Enable the signed webhook (`RAZORPAY_WEBHOOK_SECRET` +
   `RAZORPAY_WEBHOOK_ENABLED`) as a second push rail.
4. Optionally configure the gmail claim rail (`GMAIL_OAUTH_*`,
   `PAYMENT_ACCOUNT_EMAIL`) as fallback.
5. Service the existing founder intent (evidence or refund) via the operator
   menu — this code path does not grant without evidence.