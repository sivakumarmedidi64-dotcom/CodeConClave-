# Secret Rotation Checklist — Healing Round 1 (CB2)

**Date:** 2026-09-05
**Repository:** `C:\Users\sride\CodeConClave-`
**Audit reference:** `docs/CODECONCLAVE_FINAL_SYSTEM_AUDIT.md` — Critical Blocker 2 (on-disk plaintext secret material + stale backups)

> Security rule: this checklist records **paths, categories and disposition only** — never secret values.

---

## Inventory (paths only)

| # | Path | Category | Tracked in git (ignore rule)? | Disposition | Rotation required? | Status |
|---|------|----------|------------------------------|-------------|--------------------|--------|
| 1 | `.env` | Runtime environment source (live secrets) | NO — `*.env` ignored in `.gitignore` / `.dockerignore` / `.railwayignore` | **KEEP in place** (single env-var mechanism; never committed) | **YES** — any value exposed via backups/history must be re-issued | Active |
| 2 | `.env.bak-20260829-221944` | Stale backup of live env | NO — `*.env*` ignored | **REMOVED 2026-09-05** | YES (values matched live `.env`) | **REMOVED** |
| 3 | `.env.bak-revoke-20260829-233853` | Stale backup (pre-revocation snapshot) | NO — `*.env*` ignored | **REMOVED 2026-09-05** | YES | **REMOVED** |
| 4 | `GMAIL_APPS_SCRIPT_SHARED_SECRET.txt` | Apps-Script shared secret, plaintext at root | NO — `*.txt` ignored | **REMOVED 2026-09-05** | YES if ever deployed/revoked | **REMOVED** |
| 5 | `.env.example` | Placeholder template (no values) | YES — negation `!.env.example` | **KEEP** | NO — verified zero secret-pattern matches (104 keys, all empty placeholders) | Safe |
| 6 | Root `*.txt` planning transcripts | User-owned scratch notes (may echo old var names) | NO — `*.txt` ignored | **KEEP** (not deleted; user-owned) | **YES — treat as potentially exposed; rotate any credential that appears there** | Review |

Remaining on-disk live-secret files after removal: **1** (`.env` only, intentional).

---

## Rotation instructions (values to be filled by the human in `.env`)

For every credential present in `.env`, propagate any re-issued value **only** into `.env` (or the deployment secret store). Do not paste values into chat or files. Affected credential categories, per the audit:

1. **Payment** — Razorpay key/secret and any live key IDs.
2. **Session/auth** — `SESSION_SECRET`, `JWT_SECRET`, OAuth client secrets.
3. **Provider AI keys** — Anthropic / OpenAI / Gemini / Mistral.
4. **Infrastructure** — `DATABASE_URL`, `REDIS_URL`, S3, Resend, Cloudflare, Sentry.
5. **Gmail Apps Script** — the removed shared secret; replace via env var only (schema key `GMAIL_CLAIM_HMAC_SECRET`), never a root-level `.txt`.

---

## Verification after rotation

- `npm run secret:scan` exits **0** with `findings=0`.
- No `.env.bak-*`, `*SHARED*SECRET*.txt`, or `*.bak*` files remain at repo root (checked by CB2 re-verification).
- `docs/CODECONCLAVE_FINAL_SYSTEM_AUDIT.md` statement in `STAGE_26_FINAL_REPORT.md` about empty/dev-default values is understood as **stale** — superseded by this checklist.

---

## Git history exposure status

- Local git binary is **broken** on this machine (`BUG (fork bomb)` — path `C:\Users\sride\AppData\Local\hermes\git\bin\git.exe`); history rewrite/purge tooling could not be executed in this round.
- **GIT_HISTORY_SECRET_EXPOSURE = UNVERIFIED** → rotation of every credential that ever appeared in `.env`/backups remains **REQUIRED** regardless.
- **HISTORY_REWRITE_DECISION = HUMAN_REQUIRED** — a human must run the history sanitization/reachability purge (or confirm the repo was never pushed with secrets) before deployment.