# Zero-Domain Authentication — Recovery & Risk Policy (normative)

This document resolves the contradictions in `CodeConClave-ZERO-DOMAIN-FINAL-AUTH.pdf`
and is the authoritative policy. Where this document and the PDF disagree, this
document wins. Implemented in `backend/src/modules/auth/identity.ts`,
`backend/src/modules/auth/service.ts`, migration `0141_auth_risk_events.sql`.

## 1. Credential model (what the PDF got right)

- Handle (identifier) + keyword (scrypt hash, never plaintext) + 32-char
  account key (CSPRNG, unambiguous alphabet, hash-only storage, shown once).
- Email is a contact label only. Normal registration, login, and recovery
  never require email delivery.
- Google OAuth backend preserved, hidden, never required.

## 2. Recovery contradiction — resolved

The PDF says both "key is the only backup; loss means permanent loss" and
"support-assisted recovery using security questions". The implemented policy:

1. **Forgot keyword + HAS key → self-service recovery** (`beginRecovery` /
   `completeRecovery`): handle + key → single-use hashed expiring token →
   new keyword → sessions revoked → old key stays valid only if still
   enabled; rotation recommended. Rate-limited, anti-enumeration.
2. **Forgot keyword + LOST key → unrecoverable by design.** No email reset,
   no security questions, no support backdoor. This is intentional: any
   email-only or question-based path would become the attacker's path.
3. **Support-assisted recovery exists ONLY as a founder-executed,
   high-assurance manual process** (out-of-band identity proof, audited,
   no self-service endpoint, no email-only bypass). There is no API for it.

## 3. PDF proposals explicitly rejected (with reason)

- **SHA-256 keyword hashing → rejected.** scrypt (`hashSecret`, versioned,
  constant-time verify) is kept. Downgrading to fast SHA-256 would make
  offline brute force practical.
- **Plaintext `auth.local.json` (key stored in clear) → rejected.** The
  server stores verifiers only; desktop keeps metadata-only vaults
  (Electron `safeStorage`); the key exists in plaintext only transiently at
  issuance/confirmation. A file containing a usable secret is a leak.
- **"Ban BOTH accounts" + ₹500 unban fee → rejected.** Heuristics ban
  legitimate users (travel, new laptop, shared NAT); a paid unban changes
  the locked pricing (999/4999/9999) and monetizes false positives.
  Implemented instead: temporary rate-limit locks, key challenge escalation,
  session revocation, auditable risk events (`auth_risk_events`).
- **Security-question recovery → rejected.** Answers are low-entropy,
  phishable, and often public. The account key replaces them entirely.
- **Client-side AI as banning authority → rejected.** Risk signals are
  server-evaluated evidence triggering verification, never proof
  triggering bans. Geo/device impossibility alone never locks an account.
- **₹100 key regeneration fee → rejected.** Rotation is free and
  encouraged after any suspicion (`rotateSecurityKey`, theft report).

## 4. Risk semantics (implemented)

- Unknown device + key enabled → security-key challenge (`unknown_device`).
- Unknown device + no key → allow + record + existing new-IP hook.
- Key challenge fail → rate-limit bucket shared across credential
  endpoints (no budget multiplication), temporary lock, fraud event.
- Confirmed compromise → revoke sessions, revoke key, rotate both
  credentials, issue replacement key once.
- Multi-device is legitimate: paired devices are recognized via
  `x-device-token`; rapid switching only escalates to challenge.

## 5. What the server never stores

Plaintext keywords, plaintext keys, provider secrets, database credentials,
session secrets. Key plaintext exists only in the issuance response and the
user's paste-back, never at rest, never in logs.
