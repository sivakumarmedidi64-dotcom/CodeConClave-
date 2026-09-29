# CodeConClave — ZERO-ADMIN PAYMENT ARCHITECTURE DECISION

> Date: 2026-08-31. No payment made, nothing deployed, no code changed, no secrets exposed.

## Executive answer
- **CURRENT_ZERO_ADMIN = BLOCKED** for a real first customer via the *static* Pro/Team links.
- **STATIC_LINK_ZERO_ADMIN = UNSAFE** — the shared static links carry no unique server reference, so the Gmail rail cannot attribute a payment to exactly one user.
- **UNIQUE_REFERENCE_REQUIRED = YES** — it is the sole correlation anchor that ties a trusted email to exactly one CodeConClave user+intent.
- **RECOMMENDED_NOW = C** (signed Razorpay webhook) **or D** (API + webhook); **B** if webhook is slow to enable. The current Gmail bridge only becomes a viable zero-admin path once a **per-intent reference-bound Razorpay Payment Link** exists (i.e. once the Razorpay API is enabled).
- **RECOMMENDED_FINAL = D** (API + signed webhook) with Gmail retained as a secondary/fallback rail.

---

## How the Gmail rail actually correlates (the crux)
`ingestEvidence` (`pipeline.ts:84-184`) runs **inside an authenticated user's specific intent**. It calls `gmailSource.collect(reference)` and the matcher **drops any email that does not contain that user's exact server-issued reference** (`CCPRO-xxxxxx`/`CCTEAM-xxxxxx`, `evidence.ts:304-307`).

**The Gmail reader does NOT scan the mailbox to discover who paid.** User correlation is established by the **authenticated session that created the intent**; Gmail only *confirms* that a trusted Razorpay receipt for that user's unique reference exists. The unique reference IS the correlation key — it must appear verbatim in the email.

---

## Answers to the 12 questions

1. **Can a unique CodeConClave reference appear in the confirmation email?**
   **Only via a per-intent Razorpay Payment Link** that sets `reference_id`/`notes.intent_id` (`service.ts:129,134`). The current **static public link binds no reference** and Razorpay never prints one in a hosted receipt ⇒ reference does NOT appear with the static link. Even with the API, the reference must actually be rendered in the email body/subject for `mailTextOf` to find it — not guaranteed for hosted links.

2. **Can the Gmail reader extract that exact reference?**
   **YES** — `mailTextOf` (subject + body) + regex `CC(PRO|TEAM)-[A-Z0-9]{6}` (`evidence.ts:216-237,304-305`). Works *if* the reference is present in the email text.

3. **Can it associate it with exactly one user?**
   **Yes, but only through the authenticated intent owner**, not mailbox-wide attribution. `collect` is scoped to one user's intent, and only the exact reference match is released. There is **no cross-user attribution**; a reference is collision-safe/UNIQUE. With the static link (no reference) ⇒ correlation is **impossible**.

4. **Can it validate the amount?**
   **YES** — exact `amountInr === intent.amount_inr`, tolerance 0 (`matcher.ts:48`, `env.ts:97`); only exact match scores the amount signal.

5. **Can it validate the plan?**
   **YES** — plan is server-authoritative; reference prefix `CCPRO-…`/`CCTEAM-…` + per-plan link mapping; invalid plan throws, no cross-plan fallback (`service.ts:57-60`).

6. **Can a duplicate email cause duplicate activation?**
   **NO** — `signalSha256` replay guard + `payment_evidence.sha256 … intent_id IS DISTINCT` check (`pipeline.ts:115-131`) + exactly-once intent state guard (`activation.ts:111-115`). Idempotent.

7. **Can a forged/spoofed email activate?**
   **NO** — `isAuthenticRazorpayMail` requires DKIM or SPF or DMARC=pass bound to `razorpay.com` AND `From` domain `razorpay.com` (`evidence.ts:247-260`). Spoofed mail dropped before matching.

8. **Can a user manipulate a client-side value to activate?**
   **No** — reference is server-generated per intent; the intent-owner check binds evidence to the correct user; user-asserted sources (manual/OCR) are forced to REVIEW, never ACTIVE (`pipeline.ts:66-78`). Trusted = gmail here only.

9. **What when the email is delayed?**
   **Degrades gracefully** — watchdog `verifyPendingPayments` polls PENDING/REVIEW and activates when trusted evidence arrives (`service.ts:589-621`). Risk: expiry/grace windows may lapse; not a security hole.

10. **What when the email is missing?**
    **Intent stays PENDING/REVIEW** — there is no manual grant and no auto-ACTIVE without trusted evidence. Reporter must reconcile. SAFE (no false activation).

11. **Two users pay the same static link?**
    **Cannot be distinguished** — no reference, so the Gmail matcher drops both receipts; both intents sit in REVIEW. **UNSAFE for zero-admin** (an admin must reconcile), though not a false-activation security hole.

12. **Can the current static Pro/Team links ever support safe per-user zero-admin activation?**
    **NO / UNSAFE** — they carry no per-user reference and no way to capture one into a hosted payment. Zero-admin requires a unique, user-bound reference reachable in trusted evidence, which only a per-intent (API-minted) link can provide.

---

## Hard conclusion
The current **Gmail bridge cannot safely accomplish zero-admin activation** for a real first customer **while the shared static links are in use and the Razorpay API is unavailable**, because:
- No unique reference reaches the payment/email ⇒ the Gmail matcher cannot attribute the receipt to exactly one user (Q3/Q11/Q12); intents land in REVIEW requiring human action.
- The Gmail rail itself is secure and correct, but it **requires a reference-bearing per-intent payment link to function as zero-admin** — and minting one is exactly what needs the Razorpay **API** (currently unavailable).

---

## Option ranking (6 criteria × 4 options)

| Criterion | A: Gmail bridge (static links) | B: Razorpay API | C: signed webhook | D: API + webhook |
|---|---|---|---|---|
| Security | Medium* (origin-auth, no false activation; but no unique correlation) | High (API-authoritative, per-intent ref) | **Highest** (signed, event-authoritative) | **Highest** |
| User experience | Poor (fragile: needs email text to carry ref) | Good (per-intent link) | **Best** (instant) | **Best** |
| Zero admin | False (REVIEW) | High (link ref + API poll/evidence) | **True** (event-driven ACTIVE) | **True** (+ reconciliation) |
| Reliability | Low (email parsing, delay, missing) | Medium (polling) | **High** (push) | **High** |
| Implementation cost | Low (done) | Medium (API + per-intent link WIP) | Medium (webhook listener done; needs config/secret) | Medium (most moving parts, all PRIMARILY implemented) |
| Current availability | **Ready now, but BLOCKED for zero-admin** | **Not available** (no keys) | **Not available** (no secret/webhook) | **Not available** |

\* The Gmail bridge is secure (origin-auth, idempotency, no manual activation) — its problem is **correlation, not authorization**.

### Ranking summary
- **Security:** D ≥ C > B > A
- **User experience:** D = C > B > A
- **Zero admin:** D = C > B > A (A provides none today)
- **Reliability:** D > C > B > A
- **Implementation cost (lower = better):** A < B < C < D (C/D are mostly built already; D needs key+secret+webhook config)
- **Current availability:** All B/C/D are blocked by missing credentials today; A is available but cannot deliver zero-admin.

---

## Recommendation
- **RECOMMENDED_NOW = C or B.** The architecture for C (signed webhook listener, events, idempotency, auto-activation) and B (per-intent API links) is already implemented and handler-level tested. Enabling is a small env + backend redeploy:
  - For **C (webhook)**: set `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_WEBHOOK_ENABLED=true`, register the webhook URL with the needed events (`payment_link.paid`, etc.) + signature verification in the Razorpay dashboard. Auto-activation is event-driven (best reliability/UX).
  - For **B (API)**: set `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`; the server then mints a per-intent reference-bound Payment Link that also feeds the Gmail rail as a secondary signal.
- **RECOMMENDED_FINAL = D** (API + signed webhook): per-intent links for checkout/UX + signed webhook for authoritative zero-admin auto-activation + API reconciliation; Gmail retained as a fallback evidence rail. Full coverage of the target chain:
  `customer → intent → unique reference → payment → trusted evidence (webhook/API/Gmail) → exact user+plan+amount → idempotency → ACTIVE → no admin`.

- **CURRENT_ZERO_ADMIN = BLOCKED** for the static-link-only, no-API/no-webhook configuration. Until Razorpay API and/or signed webhook is enabled, zero-admin activation **cannot be safely delivered**, and the static links should **not** be used as a zero-admin acceptance path (they can only produce REVIEW outcomes).
