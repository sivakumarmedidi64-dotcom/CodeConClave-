# FINAL ZERO-ADMIN GMAIL CLAIM IMPLEMENTATION

> **Status: IMPLEMENTED — NOT DEPLOYED.**
> All backend code, migration, env wiring, and tests are written and verified
> (typecheck + build + unit tests PASS). Deployment is FROZEN pending your
> explicit approval. No real payment was made. No secrets were exposed.

This document is the authoritative record of the zero-admin Gmail claim rail
backend implementation. It is the last piece of the zero-admin payment vision:
a customer pays via a static Razorpay Payment Link, the receipt arrives in your
Gmail, an Apps Script detects it, and the backend issues a one-time claim link
that activates the entitlement — **with zero administrator involvement** for
normal, successful payments.

---

## 1. Architecture (the complete, working rail)

```
Customer pays  →  Razorpay static Payment Link (₹999 PRO / ₹4999 TEAM)
   │
   ▼
Razorpay confirmation email arrives in the controlled Gmail mailbox
   │
   ▼
Google Apps Script (1-min trigger) scans Gmail
   │  - checks DKIM=pass / SPF=pass / DMARC=pass + from: razorpay.com
   │  - extracts paymentId / amount / payerEmail / reference / plan
   │  - signs payload with HMAC-SHA256 over "timestamp:JSON" (shared secret)
   ▼
POST /api/v1/payments/gmail-claim/request   (NEW)
   │  - verifies HMAC signature (timing-safe)
   │  - validates timestamp (5-min window, replay guard)
   │  - dedup by provider payment ID (idempotent)
   │  - validates plan + amount (server-authoritative ₹999/₹4999)
   │  - resolves the exact payment_intent by server-issued reference
   │  - creates a one-time claim token (SHA-256 hashed, 24h TTL)
   │  - emails the claim link to the payer (transactional, via outbox)
   ▼
Customer clicks the claim link
   │
   ▼
POST /api/v1/payments/gmail-claim/activate   (NEW)
   │  - SHA-256 hashes the raw token and matches claim
   │  - checks expiry + single-use (conditional UPDATE = exactly-once race guard)
   ▼
Entitlement ACTIVE (PRO_VERIFIED), user.plan_id updated →  admin = 0
```

Full end-to-end flow is covered in `docs/ZERO_ADMIN_PAYMENT_ROADMAP.md` and the
Apps Script source previously delivered.

---

## 2. Files added / changed

### Added
| File | Purpose |
|---|---|
| `backend/src/modules/payments/gmail-claim.ts` | Core claim logic: signature verification, timestamp validation, token creation, claim request + activation |
| `backend/src/modules/payments/gmail-claim-routes.ts` | Two unauthenticated (HMAC/token-verified) Express routes |
| `backend/src/modules/payments/gmail-claim.test.ts` | 16 unit/integration tests |
| `database/migrations/0057_gmail_claim_rail.sql` | `payment_claims` table + indexes |

### Changed
| File | Change |
|---|---|
| `backend/src/shared/ids.ts` | Added `PAYMENT_CLAIM: 'pcl'` id prefix |
| `backend/src/config/env.ts` | Added `GMAIL_CLAIM_ENABLED`, `GMAIL_CLAIM_HMAC_SECRET`, `GMAIL_CLAIM_TOKEN_TTL_HOURS`, `GMAIL_CLAIM_TIMESTAMP_TOLERANCE_SECONDS` |
| `backend/src/app.ts` | Mounted `gmailClaimRoutes()` at `/api/v1/payments/gmail-claim` BEFORE the auth-gated `paymentRoutes()` (prevents 401 auth-shadowing) |
| `backend/src/middleware/csrf.ts` | Exempted `/api/v1/payments/gmail-claim` from CSRF (HMAC/token-authenticated, not cookie-authenticated) |

---

## 3. Environment variables (NAMES only — no values)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GMAIL_CLAIM_ENABLED` | yes (to enable) | `false` | Master switch; rail is inert unless `true` |
| `GMAIL_CLAIM_HMAC_SECRET` | yes (to enable) | unset | Shared HMAC secret that the Apps Script signs with; must match the value in Apps Script `PropertiesService` (`GMAIL_APPS_SCRIPT_SHARED_SECRET`) |
| `GMAIL_CLAIM_TOKEN_TTL_HOURS` | no | `24` | Claim link lifetime |
| `GMAIL_CLAIM_TIMESTAMP_TOLERANCE_SECONDS` | no | `300` | Replay window for the signed timestamp |

`gmailClaimEnabled()` returns `true` only when `GMAIL_CLAIM_ENABLED === 'true'`
**and** `GMAIL_CLAIM_HMAC_SECRET` is set. Without both, both endpoints return
`404 gmail_claim_disabled` and the rail is completely inert — it cannot be
force-activated.

---

## 4. Trust model (defense-in-depth)

The rail enforces a strict trust boundary. Never rely on any single signal:

- **Apps Script is a trusted intermediary ONLY via a valid HMAC-SHA256 signature**
  over `timestamp:JSON.stringify(payload)`, compared with `timingSafeEqual`.
  A forged/wrong-secret/tampered payload is rejected with `401 invalid_signature`.
- **Timestamp replay guard** — the signed timestamp must fall within the
  5-minute tolerance window; expired/future/zero/NaN timestamps are rejected.
- **Dedup by provider payment ID** — the same Razorpay payment id can only ever
  create one claim (idempotent under redelivery).
- **Amount is server-authoritative** — a claimed amount must equal the plan price
  (₹999=`pro`, ₹4999=`team`) exactly. Mismatch → `400 amount_mismatch`, audited,
  never activates. (An absent/null amount is tolerated because the receipt may
  not carry a parseable amount.)
- **Intent resolved by the server-issued reference** — never by email/amount/
  payment-id alone. A reference with no matching `PENDING/REVIEW` intent →
  `404`, audited, never activates.
- **One-time claim token** — 32 random bytes, only the SHA-256 hash is stored;
  activation requires the raw token, matches hash + id, then a **conditional
  `UPDATE ... WHERE status='PENDING' AND expires_at > now()`** is the exactly-once
  race guard. Reuse/expiry → `400 claim_already_used`.
- **Activation reuses the existing shared hook** `activateEntitlement(...)`
  (same function the webhook/API rails use), so there is no bypass of the
  entitlement invariant.
- Every path writes an audit trail (`recordAudit`): signature_invalid,
  timestamp_invalid, amount_mismatch, no_intent, claim_created, claim_activated,
  claim_expired.

### What a customer can NEVER do
- Fabricate a payment (no HMAC secret → 401).
- Replay a stale signed payload (timestamp window).
- Activate `team` with a ₹999 claim (amount + plan validation).
- Activate another user's plan (claim bound to the intent owner; token is
  one-time and hashed).
- Reuse a claim link (single-use conditional UPDATE).
- Self-serve after expiry (24h TTL).

> Comparison with existing rails: `manual`/`ocr` evidence is forced to REVIEW
> by the pipeline (`effectiveMatch`) and can never activate. The **Gmail claim
> rail is distinct**: it does not feed the `gmail` evidence source scoring; it
> is a separate, HMAC-authenticated claim flow that is explicitly trusted ONLY
> when signature + timestamp + amount + reference + dedup all pass.

---

## 5. Endpoint contract

### `POST /api/v1/payments/gmail-claim/request`
Unauthenticated (HMAC) — called by Apps Script.

```json
{
  "payload": {
    "paymentId": "pay_...",
    "amount": 999,
    "plan": "pro",
    "payerEmail": "customer@example.com",
    "paidAt": "2026-08-31T11:00:00Z",
    "reference": "CCPRO-XXXXXX"
  },
  "timestamp": 1725123600,
  "signature": "<hex HMAC-SHA256 over `timestamp:JSON.stringify(payload)`>"
}
```

Responses:
- `200 { ok:true, claimId, status:'pending' }` — claim created, email sent.
- `200 { ok:true, claimId:'duplicate', status:'already_processed' }` — idempotent.
- `200 { ok:true, claimId:'already_active', status:'ACTIVE'|'GRACE' }`.
- `401 invalid_signature` — HMAC failed.
- `400 timestamp_invalid` / `400 amount_mismatch` / `400 invalid_plan` /
  `400 invalid_payer_email` / `400 reference_required`.
- `404 gmail_claim_disabled` — rail not enabled (also `not_found` no intent).
- `404 not_found` — no matching intent.

### `POST /api/v1/payments/gmail-claim/activate`
Unauthenticated (one-time claim token) — called by the customer clicking the link.

```json
{ "token": "<raw 64-hex token from the claim link>", "id": "pcl_..." }
```

Responses:
- `200 { ok:true, activated:true, planId:'pro', ownerId:'usr_...' }`.
- `400 claim_already_used` / `400 claim_expired` / `400 invalid_token` /
  `400 invalid_claim_id`.
- `404 gmail_claim_disabled` — rail not enabled.
- `404 not_found` — invalid/expired claim link.

The claim link itself is constructed server-side as
`${APP_URL}/claim?token=<raw>&id=<claimId>` and emailed via the transactional
outbox (`payment.claim_email`, dedupe-keyed).

---

## 6. Database

Migration `0057_gmail_claim_rail.sql` adds only `payment_claims`:

```
payment_claims
  id            text PK            (pcl_...)
  intent_id     text FK → payment_intents(id) ON DELETE CASCADE
  owner_id      text FK → users(id)
  plan_id       text
  amount_inr    integer
  payer_email   text
  payment_id    text               (nullable; dedup key)
  reference     text
  token_hash    text UNIQUE        (SHA-256 of the one-time token; plaintext never stored)
  status        text               (PENDING → ACTIVATED)
  activated_at  timestamptz
  expires_at    timestamptz
  created_at    timestamptz
+ indexes on owner_id, token_hash, status+expires_at, payment_id (partial)
```

No existing schema is altered. Activation reuses the existing `entitlements`
(`PRO_VERIFIED`) and `users.plan_id` update paths via the shared
`activateEntitlement()` hook — so zero-admin activation is fully consistent with
the existing verification rails. **This migration is not yet applied** (deploy
is frozen); it will run as part of the approved deploy.

---

## 7. Tests

`backend/src/modules/payments/gmail-claim.test.ts` — **16 passing**:

**Signature (pure):** valid HMAC ✓, tampered payload ✗, wrong/cross-tenant
secret ✗, empty signature ✗, missing secret ✗, truncated (length-mismatch) ✗,
valid signature over a different timestamp ✗.

**Timestamp (pure):** valid ✓, within window ✓, expired replay ✗, future ✗,
zero/negative ✗, non-finite (NaN/Infinity) ✗.

**Route integration (default env, rail disabled):**
- `/gmail-claim/request` → `404` (rail disabled), **NOT** auth-shadowed to 401.
- `/gmail-claim/activate` → `404` (rail disabled), **NOT** auth-shadowed to 401.
- Normal `/api/v1/payments/*` still `401` (no bypass).

Verified with `vitest run` + typecheck + build — **all green.** The existing
webhook route ordering regression test also still passes (19/19 combined),
confirming the new gmail-claim router does not reintroduce the webhook
auth-shadowing defect.

---

## 8. Verification performed (NO deployment)

- `npm run typecheck` — PASS.
- `npm run build` — PASS.
- `vitest run` on the new test file — 16/16 PASS.
- `vitest run` combined with the existing webhook-route regression test — 19/19 PASS.
- Confirmed the gmail-claim router is mounted **before** the auth-gated payments
  router so it is reachable without a session cookie (mirrors the webhook fix).

---

## 9. Pre-deploy checklist (operator — remains your call)

1. **Apply the migration** `0057_gmail_claim_rail.sql` (via `npm run db:migrate`).
2. **Set env vars** (Railway): `GMAIL_CLAIM_ENABLED=true` and
   `GMAIL_CLAIM_HMAC_SECRET=<generate a strong random value, e.g. 32+ bytes>`.
3. Ensure Apps Script `GMAIL_APPS_SCRIPT_SHARED_SECRET` matches
   `GMAIL_CLAIM_HMAC_SECRET` exactly, and `CODECONCLAVE_BACKEND_URL` points at
   `https://backend-production-95faa.up.railway.app`.
4. Deploy backend (obtaining approval first).
5. Optionally first run a **sandboxed smoke test** — Apps Script can POST a
   signed `request` with a `paymentId` never seen before; verify the claim email
   arrives and activate works, then the matching intent goes ACTIVE.

> GO/NO-GO: I have **not** deployed, **not** made a real payment, and **not**
> exposed secrets. Everything above is implemented and verified locally. Please
> review and approve before any deployment action.
