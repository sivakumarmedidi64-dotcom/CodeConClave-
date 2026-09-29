# CodeConClave — Final Auth Design (Master Decision Record)

Status: **DECIDED — NOT YET IMPLEMENTED.**
Date decided: 2026-09-27.
Supersedes: all `Downloads/CodeConClave*Auth*.md` drafts and the v1/v2/v3 local-only
proposals. This document is the single source of truth for the keyword auth design.

No code has been written for this design. Implementation requires separate,
explicit founder authorization.

---

## 1. The one rule

**The keyword is the only secret.**

Email is a label. The security key is a backup. There is no OTP, no OAuth, no
email provider, no sending domain, and no support-side recovery backdoor.

---

## 2. Locked decisions

| # | Decision | Value |
|---|---|---|
| D1 | Email identity | **Unverified label + unique `handle` as the account key** |
| D2 | Security key scope | **Recovery AND optional second factor at login** |
| D3 | Identity location | **Server-side** (required for payments/entitlements/sync) |
| D4 | Password hashing | **Server-side Argon2id**, per-user 32-byte salt |
| D5 | Session handling | **Reuse existing `cc_session` + CSRF** — no new JWT, no parallel user table |
| D6 | Keyword change | Requires **current keyword**; revokes all sessions |
| D7 | Forgot keyword | **Security key only.** No email link, no support bypass |
| D8 | Theft report | Requires current keyword; revokes all sessions; audit logged |

### D1 — Email identity (locked)

Email is a **display/contact label only** and is never verified. The real unique
account key is a separate, user-chosen, unique `handle`.

Consequences accepted:
- Zero email provider cost, zero domain cost, zero verified-domain blocker.
- Account squatting is impossible to route against a real inbox, because email
  is not the identity key — a third party registering your email address gains
  nothing and cannot lock you out.
- The account is not recoverable by email, by design.

`handle` collision at registration is resolved by the same generic-message policy
as login (see §5), and squatting a handle is visible and handled by the existing
moderation/audit path.

### D2 — Security key scope (locked)

The security key is used for **both**:
1. Forgot-keyword recovery (always available).
2. Optional second factor at login for paid accounts.

This converts the security key from a single-purpose recovery secret into real
second-factor protection, and removes "no 2FA/MFA built-in" from the weakness list.

---

## 3. What was rejected, and why

| Rejected proposal | Reason for rejection |
|---|---|
| v1 local-only, plaintext keys | Keys readable in any text editor; hard device block punished the legitimate owner |
| v2 AES-GCM + optional server | Reused/static nonce; server dependency contradicted the "local" claim |
| v3 100% local, keyword = authority | Secure in isolation, but breaks payments, quota, entitlements, teams, sync, and web/desktop parity — identity must exist server-side |
| Client-side hashing, then sending the hash | Pass-the-hash: a database leak becomes login-as-every-user without needing the real keyword |
| Email-link recovery | Silently reintroduced the domain/provider blocker the redesign was meant to remove |
| Local encrypted credential file store | Second file store with no consumer, contradicts the single existing local-agent design |

---

## 4. Architecture — extends, never replaces

- **Identity:** server-side account record, linked to the existing `account_id`.
- **Sessions:** existing `cc_session` cookie + CSRF token. `HttpOnly`, `Secure`,
  `SameSite=Lax`, 24h. No JWT, no token blacklist, no second user table.
- **Row-level security, entitlements, quota, audit logs:** unchanged.
- **Payments:** unchanged. Auth only links to an existing account.
- **Local-agent file access:** unchanged — same real paths, policy, approvals, audit.

The authentication *mechanism* changes. The authentication *architecture* does not.

---

## 5. Flows (final)

### Register
1. Inputs: `handle` (unique), email (label), display name, role, keyword (8–50 chars).
2. Server generates 32-byte salt; `Argon2id(keyword, salt, t=3, m=64MB, p=4)`.
3. Server generates security key via CSPRNG — 32 chars, unambiguous alphabet
   (no `0/O`, `1/l`/`I` ambiguity).
4. Security key shown **once**. User must **paste it back** to confirm it was saved.
5. Security key is stored as an **Argon2id hash**, never plaintext, never SHA-256.
6. Session created. Account created unverified.

### Login
1. Inputs: `handle` (or email, resolved to account) + keyword, over TLS 1.3.
2. Missing / unknown account / wrong keyword → **one identical** response:
   `401 "Email or keyword incorrect"`. No enumeration via message, status, or field.
3. Hash comparison is constant-time.
4. 5 failed attempts → 15-minute soft lockout. Rate-limited per IP **and** per account.
5. If 2FA is enabled for the account → prompt for security key.
6. Success → `cc_session` issued.

### Change keyword
1. Requires **current keyword** + valid session.
2. New salt, new Argon2id hash.
3. **All sessions invalidated on all devices**, including the current one.
4. Audit log entry written.

### Recover (forgot keyword)
1. Inputs: account identifier + **security key**.
2. Endpoint is **rate-limited and lockout-protected exactly like login** — an
   unauthenticated endpoint keyed on an identifier must never permit unlimited guessing.
3. On success: single-use recovery token, 1-hour expiry, bound to the account.
   Token is never logged. Token is **invalidated the instant** a new keyword is set.
4. Set new keyword → all sessions invalidated.
5. Generic failure message; indistinguishable from a wrong security key.

### Report theft
1. Requires **current keyword** (so a thief holding only a session cannot lock the
   owner out by reporting) + valid session.
2. **All sessions invalidated immediately** on every device.
3. Account flagged compromised; audit entry with IP and user agent.
4. Owner then changes keyword or uses the recovery path.

---

## 6. Security key rules

These were the weakest link in earlier drafts and are now fixed:

1. **CSPRNG only.** Never sequential or memorable (e.g. `ABC123XYZ456...` is invalid).
2. Stored as **Argon2id hash**, same cost as the keyword — the recovery path must not
   be the cheap path to crack.
3. **One per account.** Never regenerated without the keyword.
4. **Recovery endpoint is rate-limited.** No unlimited guessing.
5. Paste-back confirmation at registration to catch "I lost it in 10 seconds".
6. Eligible to serve as an **optional login second factor** (D2).

---

## 7. Non-goals (explicitly out of scope)

- No local encrypted credential store / second file store.
- No offline keyword verification — the hash lives server-side only. Offline access
  works only while an existing session remains valid.
- No self-service recovery without **both** keyword and security key.
- No proactive theft alerts (would require an email provider). Theft detection is
  **log-based**: the owner must review activity logs.
- No local-agent, payment, entitlement, RLS, or auth-architecture changes.

---

## 8. Migration

Existing accounts keep working. Keyword login is **opt-in at first login**. No
current user is locked out. Existing Google OAuth sign-in continues to work during
the migration window; keyword login is additive, not a forced cutover.

---

## 9. Honest, accepted limits

- **Forgot keyword AND lost security key = account permanently gone.** This is the
  direct, unavoidable cost of having no recovery backdoor. Accepted deliberately.
- No way to prove an email inbox is yours. The system never pretends otherwise.
- Theft detection is log-based, not alert-based.
- Offline mode is session-scoped, not credential-scoped.

---

## 10. Relationship to the Google OAuth release gate

`CODECONCLAVE_FOUNDER_RELEASE_CHECKLIST.md` Gate 1 is `GOOGLE_OAUTH_LOGIN`. This
design does not remove that gate. Google OAuth remains live and valid during
migration; keyword auth is added alongside it. If the founder later decides to make
keyword auth the primary path, the founder checklist and its acceptance evidence
must be updated in a separate, explicitly authorized change.

---

## 11. Implementation prerequisites (not yet started)

Before any code is written for this design:

1. Map the existing auth routes, tables, session invalidation, and CSRF handling.
2. Confirm the actual desktop target (**Electron**, not Tauri) — earlier drafts
   referenced `src-tauri/` and `npm run tauri build`, which do not apply.
3. Define the `handle` uniqueness and generic-conflict response behavior.
4. Define the 2FA opt-in entitlement rule for paid accounts.
5. Produce the test plan covering: enumeration, pass-the-hash absence, session
   revocation, recovery-token single-use/expiry, and recovery rate limiting.

**No implementation is authorized until the founder explicitly says go.**

---

## 12. Implementation status (appended 2026-09-28)

Sections 1–11 are the founder's decision record and are left **verbatim**. This
section records what was actually built and, where it departs from the text
above, **what still needs founder ratification**. Nothing in sections 1–11 was
silently rewritten.

### Built and verified

| Area | Where | Notes |
| --- | --- | --- |
| Schema | `database/migrations/0133_auth_identity_and_founder.sql` | `user_auth_identities`, `auth_recovery_tokens`, `users.is_founder`, case-insensitive handle uniqueness, RLS |
| Policy | `backend/src/modules/auth/identity-policy.ts` | Pure handle/keyword rules, shared with the client contract |
| Login / MFA / recovery | `backend/src/modules/auth/identity.ts` | handle+keyword login, TOTP, Security Key, recovery, theft report, session revocation |
| HTTP surface | `backend/src/modules/auth/routes.ts` | incl. `POST /api/v1/auth/identity/mfa/verify` |
| Registration | `backend/src/modules/auth/service.ts` | handle+keyword accepted atomically; omitting both stays valid for legacy clients |
| Credential hashing | `backend/src/shared/crypto.ts` | versioned scrypt, transparent v1→v2 upgrade on successful login |
| Founder provisioning | `backend/src/scripts/provision-founder.ts` + `npm run founder:provision` | three-condition rule enforced in SQL, not just documented |

### Deliberate deviations from sections 1–11 (need ratification)

1. **Hash is scrypt, not Argon2id** (§5, §6.2). Argon2id is not available in the
   Node runtime without a native add-on. `scrypt` is the built-in KDF. Parameters
   were chosen on measurement, not preference: `N=65536, r=8, p=1` (v2), with
   `N=262144` **rejected** because it allocates 256MB per verification and would
   OOM the instance under the auth rate limiter. v1 (`N=16384`) hashes stay valid
   forever and are transparently upgraded on first successful login.
2. **Keyword policy is 12–128 chars requiring lower + upper + digit** (§5 says
   8–50). The original rule accepted all-lowercase, all-digit passphrases, which
   is a materially weaker secret than the design's own threat model assumes.
3. **Security Key is two-phase and opt-in, not issued at registration** (§5.3–5).
   The key is shown once and must be **pasted back** to confirm it was saved, but
   it is never generated as a side effect of registering. Issuing it unasked
   would put an unrecoverable second factor in front of every new user.
4. **TOTP is a supported second factor alongside the Security Key** (§D2 said
   TOTP untouched; it is). Where both exist, `preferred_mfa` demands **exactly
   one** — a user is never asked for both.
5. **An MFA challenge is single-use** (§5.6 says a challenge then a session; it
   does not say the challenge is reusable). `imfa_…` tokens are burned by
   `cache.incr` on first verification, including on a **wrong** second factor, so
   a leaked token cannot be paired with a later guess. Store outage fails closed.
6. **Recovery token TTL is 15 minutes, not 1 hour** (§5.3), issued only by
   Security-Key proof, hashed, single-use, attempt-capped, with issuance
   serialised by a row lock so concurrent calls cannot produce two live tokens.
   There is still **no email reset path**, so keyword + security key both lost is
   still a permanent loss — §9 stands.

### Still outstanding (unchanged from the previous status)

- Web and Electron clients still expose only the legacy auth UI: no handle +
  keyword form, no identity enrolment, no TOTP completion, no Security Key
  enrollment, no recovery, no theft reporting.
- `/api/v1/auth/identity/*` has no machine-checked OpenAPI annotations; the route
  mount is registered with the endpoint-spec linter only as `/api/v1/auth`.
- No production-like PostgreSQL run yet, so `0133` (RLS, backfill collisions,
  triggers, ledger repair, repeat execution) is unverified against a real server.
- Provider/admin signed lifecycle webhooks for refund, revoke, and chargeback are
  not wired; the customer-authenticated routes that used to allow them are gone.

