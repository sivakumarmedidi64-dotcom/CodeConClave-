# Customer-Receipt Forwarding for Automatic Payment Unlock — Feasibility Analysis

**Scope:** Assess whether a customer forwarding a Razorpay payment receipt to
`unlock@codeconclave.com` (received by Gmail, watchdog Apps Script + backend)
can provide **secure, zero-admin, automatic** unlock — with **no Razorpay API,
no webhooks, and no human admin** in the path.

**Investigation only.** No deployment, no real payment, no source-code changes.

---

## 1. Verdict Summary

| Decision | Verdict |
|---|---|
| `CUSTOMER_RECEIPT_FORWARD` | **UNSAFE / INSUFFICIENT** |
| `RECEIPT_AUTHENTICITY` | **INSUFFICIENT** (cannot prove razorpay.com produced it) |
| `USER_CORRELATION` | **FAIL** (payer email ≠ CodeConClave identity) |
| `PAYMENT_VERIFICATION` | **IMPOSSIBLE** independently (no API/webhook) |
| `STATIC_LINK` | **NO per-user reference** |
| `CUSTOMER_ACTION_REQUIRED` | **YES** (forward step = manual action) |
| `ADMIN_ACTION_REQUIRED` | **YES** (REVIEW/OCR needed — not zero-admin) |
| `REFUND_REVOCATION` | **NOT_AVAILABLE** without API/webhook |
| `AUTO_UNLOCK` | **NO** (every receipt lands in REVIEW) |

**`NO_API/NO_WEBHOOK/NO_ADMIN = NOT_POSSIBLE_WITH_CURRENT_RAZORPAY_CAPABILITIES`**

**`FINAL_DECISION = REJECT`** — the customer-receipt forwarding path does **not**
provide a secure zero-admin automatic activation rail. It is, by construction,
client-supplied, manually-authored/transported evidence that the backend cannot
cryptographically bind to Razorpay.

---

## 2. What a Razorpay Customer Receipt Actually Contains

A Razorpay customer receipt (email to the payer) exposes, client-side:

- **Payer email address** (the customer's own email)
- **Order / payment ID** (displayed; backing `pay_…` / `order_…` not guaranteed
  to be present legibly in all templates; `plink_…` may or may not appear)
- **Amount / currency / date**
- **Status text** ("Payment successful")
- Offline-verifiable only by cross-checking against Razorpay
- Customer receipts can also be sent as PDF attachments

**Critical limitation:** a manual receipt gives the customer's **payer email**,
an amount, and a payment ID, but:

1. It is **not** bound to a CodeConClave user/session (static shared links have
   no per-user reference).
2. The payment ID + amount + "success" text cannot be validated by the backend
   against Razorpay without the **Razorpay API or webhook**.
3. The receipt's authenticity is **not cryptographically provable** once it has
   left the merchant/customer mailbox and been manually forwarded.

---

## 3. Forwarded-Email Authenticity — Why It FAILS

The backend's `isAuthenticRazorpayMail` (`evidence.ts`) gates Gmail evidence on
**DKIM=pass + `header.d=razorpay.com`**, **SPF=pass from razorpay.com**, and/or
**DMARC=pass + domain == razorpay.com**, with strict `fromDomain == razorpay.com`.

When a **customer** (not the merchant mailbox) forwards a Razorpay receipt to
`unlock@codeconclave.com`:

- **SPF** is computed against the **forwarding** mail path, not razorpay.com →
  SPF fails for the razorpay.com domain.
- **DKIM** survives only if the signed headers + body are byte-for-byte intact.
  Gmail's Forward re-injects/re-signs the message, and Gmail appends its own
  authentication to the **forwarded** send, so the visible
  `Authentication-Results` reflects the **forwarder's** identity, not razorpay.com.
  Per Gmail behavior, forwarded mail does **not** carry the original domain's
  valid DKIM/SPF verdict.
- **DMARC** passes only if aligned DKIM survives — generally not on a forward.
- **Composable / forgeable:** an end user can compose a plausible-looking
  "Razorpay receipt" themselves. The forwarded message authenticates the
  **sender's** path, giving **no cryptographic proof** razorpay.com authored it.

**Result:** `isAuthenticRazorpayMail` — designed for **direct mail into the
merchant mailbox** — will **reject** genuine customer-forwarded receipts as
inauthentic, and cannot distinguish them from a fabricated forward.
`RECEIPT_AUTHENTICITY = INSUFFICIENT`.

---

## 4. User Correlation — FAIL

Even if authenticity somehow held:

- The receipt only carries the **payer email**, which for a static shared link
  (`rzp.io/rzp/sAgHIpxS`, `rzp.io/rzp/3ioXlCxd`) is **not bound** to any specific
  CodeConClave account/session.
- A forward proves nothing: **anyone can forward someone else's receipt**.
  Shared mailboxes, aliases, plus-addressing, and forwarded receipts from a
  friend all break the "this payer = this account" assumption.
- A `reference === reference` correlation (`evidence.ts:305`) requires a
  **resolvable server-issued reference** — the static links provide none.

`USER_CORRELATION = FAIL`.

---

## 5. Payment Verification — IMPOSSIBLE Independently

The backend's trusted evidence sources are `['gmail','razorpay_api','razorpay_webhook']`
(`pipeline.ts:55`). With **no API call and no webhook** configured:

- The backend cannot independently confirm that `pay_…` + amount + "success"
  corresponds to a **real, captured Razorpay payment**.
- The `gmail` rail is chained to manual/OCR → **REVIEW** because authenticity
  cannot be machine-proven for forwarded mail.
- Payment-ID-only evidence (`PAYMENT_ID_ONLY = INSUFFICIENT`) means any crafted
  forward is indistinguishable from a genuine one without an out-of-band check.

`PAYMENT_VERIFICATION = IMPOSSIBLE` under the current capability set.

---

## 6. Static Link Analysis

- PRO ₹999 `https://rzp.io/rzp/sAgHIpxS`, TEAM ₹4999 `https://rzp.io/rzp/3ioXlCxd`
  are **shared, static** links.
- Dashboard Standard Payment Links **support** an optional unique **Reference Id**
  (≤40 chars) + Notes, and the Payment Link entity exposes `id` (`plink_…`),
  `reference_id`, `order_id`, `payments[]`. **But** these exist only if a new
  link per user is created via API or dashboard — **not** on the current static
  shared links.
- The **merchant notification email body is not documented**, so `link_id` /
  `reference_id` extraction from the merchant email is `UNKNOWN` and not relied on.
- `PRECREATED_LINK_POOL = NOT_VIABLE` (carried forward). Static links give
  **no per-user reference** to correlate a receipt.

`STATIC_LINK = NO per-user reference`.

---

## 7. Customer Action vs Zero-Admin

- A customer forwarding a receipt is a **manual action** (compose + attach +
  send). This is **not zero-action**.
- On receipt, the backend cannot auto-verify → the watchdog/OCR path escalates to
  **REVIEW** (human admin). So even with the user providing evidence, an **admin
  action** is still required. Not zero-admin.

`CUSTOMER_ACTION_REQUIRED = YES`, `ADMIN_ACTION_REQUIRED = YES`.

---

## 8. One-Time Activation / Replay

A one-time activation design still cannot solve **payment trust**: the backend
cannot prove the first activation was for a real captured payment. Replay of the
same fabricated forward just re-triggers REVIEW. One-time binding is **irrelevant**
when verification is impossible.

---

## 9. Security Attack Cases

| Attack | Against this design |
|---|---|
| Fabricate a "receipt" forward | **Succeeds** — no crypto proof of razorpay.com origin |
| Forward someone else's receipt | **Succeeds** — payer email ≠ account identity |
| Shared/alias payer email | **Succeeds** — no binding to account |
| Re-use a past genuine format | **Succeeds** — indistinguishable client-side |
| Spoof From: razorpay.com | Neutralized only if DKIM/SPF/DMARC gate held — it does not on forwards |

Every realistic bypass is *not* mitigated. This is the opposite of the required
trust boundary (`TRUSTED_EVIDENCE_SOURCES` must be server-verified, not
client-auctioned).

---

## 10. Apps Script / Google Sheets Role

- The Apps Script watchdog (not in repo; audited via documented contract) polls
  Gmail for evidence.
- For customer-forwarded receipts, it can only surface them to
  **manual/OCR → REVIEW**.
- Google Sheets is **ledger-only**; it cannot independently verify a Razorpay
  payment. No improvement.

---

## 11. Refund / Reversal — NOT_AVAILABLE

Without the Razorpay **API/webhook**, the backend cannot detect a **refund** or
**payment reversal** and auto-revoke access. `REFUND_REVOCATION = NOT_AVAILABLE`.
A refunded payment would leave access active indefinitely — a real financial
risk that the current design **also** fails to close.

---

## 12. Option Comparison

| Option | Verdict | Needs API? |
|---|---|---|
| **A. Customer forward receipt** | **UNSAFE / REJECT** | would (verify) |
| **B. Gmail-claim / dynamic links + webhook** | **RECOMMENDED (future)** | YES |
| **C. Activation-code engine** | RECOMMENDED (future only) | YES |
| **D. Precreated static-link pool** | NOT_VIABLE | YES |
| **E. Keep manual admin** | Current fallback (not automatic) | NO |

The only reliable zero-admin path still requires **Razorpay API + webhook**
(`ACTIVATION_CODE_ENGINE = RECOMMENDED`), per prior docs.

---

## 13. Final Decision

**`FINAL_DECISION = REJECT`** — customer-receipt forwarding provides
**client-supplied, forgeable, unverifiable** evidence. The backend cannot
cryptographically bind a forwarded receipt to a real captured Razorpay payment
**without API/webhook**, cannot map payer email to a CodeConClave account, and
cannot detect refunds. It is **UNSAFE** and fails the **zero-admin / zero-manual**
requirement (customer must forward; admin must REVIEW).

**`RECOMMENDATION = WAIT_FOR_RAZORPAY_CAPABILITY`** (enable **API/webhook** to
build the recommended activation-code / gmail-claim / webhook rail). Do **not**
under any circumstance ship manual/forwarded-receipt trust.

**`REAL_PAYMENT = NOT_PERFORMED`** (none attempted)
**`DEPLOYMENT = BLOCKED`** (investigation only, no approval given)
**`SOURCE_CHANGES = NONE`** (no code modified)
