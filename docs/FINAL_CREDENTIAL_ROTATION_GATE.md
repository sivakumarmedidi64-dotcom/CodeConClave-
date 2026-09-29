# CODECONCLAVE PRO — FINAL CREDENTIAL ROTATION GATE

Credential rotation + Railway sync status for the incident where several credentials
were disclosed in earlier agent transcripts. **No secret values, fragments, hashes, or
fingerprints appear anywhere in this file.**

Status legend (values only, never shown):
`PRESENT / FRESH / OLD / MISSING / ROTATION_REQUIRED / NOT_REQUIRED / OPTIONAL / REVOKED`

Last verified: 2026-08-29. Deployment remains BLOCKED until the gate passes.

---

## Per-credential status

| Service | Variable | Required? | Exposed? | Fresh? | Railway synced? | Status |
| ------- | -------- | --------- | -------- | ------ | --------------- | ------ |
| Backend | SESSION_SECRET | Yes | Old value shown | Yes | Yes | FRESH |
| Backend | JWT_SECRET | Yes | Old value shown | Yes | Yes | FRESH |
| Backend+worker | DATABASE_URL | Yes | Yes | No | No (OLD on Railway) | ROTATION_REQUIRED |
| Backend+worker | DATABASE_SSL | Yes (config) | No | n/a | Yes = true | PASS |
| Backend+worker | REDIS_URL | No (cache-only fallback) | Yes (password) | No | No (pointing at compromised Redis) | ROTATION_REQUIRED |
| Backend | GOOGLE_CLIENT_SECRET | Yes (OAuth enabled) | Yes | No | No (OLD) | ROTATION_REQUIRED |
| Backend | GOOGLE_CLIENT_ID | Yes (OAuth) | No (public identifier) | Yes | Yes | NOT_A_SECRET |
| Backend | GOOGLE_REDIRECT_URI | Yes (OAuth) | No | Yes | Yes (production URI) | PASS |
| Backend | ANTHROPIC_API_KEY | Yes (enabled) | Yes | No | No (OLD) | ROTATION_REQUIRED |
| Backend | OPENAI_API_KEY | Yes (enabled) | Yes | No | No (OLD) | ROTATION_REQUIRED |
| Backend | GEMINI_API_KEY | Yes (enabled) | Yes | No | No (OLD) | ROTATION_REQUIRED |
| Backend | MISTRAL_API_KEY | Yes (enabled) | Yes | No | No (OLD) | ROTATION_REQUIRED |
| Backend | GROK_API_KEY | No (not enabled in launch set) | Yes | No | No (OLD) | ROTATION_REQUIRED/OPTIONAL |
| Backend | DEEPSEEK_API_KEY | No (not enabled) | Yes | No | No (OLD) | ROTATION_REQUIRED/OPTIONAL |
| Backend | KIMI_API_KEY | No (not enabled) | Yes | No | No (OLD) | ROTATION_REQUIRED/OPTIONAL |
| Backend | NVIDIA_API_KEY | No (not enabled) | Yes | No | No (OLD) | ROTATION_REQUIRED/OPTIONAL |
| Backend | COHERE_API_KEY | No (not enabled) | Yes | No | No (OLD) | ROTATION_REQUIRED/OPTIONAL |
| Backend | RESEND_API_KEY | No (RESEND_ENABLED=false) | Yes | No | No (OLD) | REVOKE/ROTATE — OPTIONAL |
| Backend | CLOUDFLARE_API_TOKEN | No (Cloudflare not a runtime dep) | Yes (old) | No (env empty) | n/a | REVOKE — NOT_REQUIRED |
| Frontend | (browser-safe config only) | — | — | — | — | No private keys ever placed in frontend |

Notes:
- AI enablement set = `anthropic,openai,google,mistral` (local .env; Railway unset →
  uses the same default from `backend/src/config/env.ts:60`). The other five providers
  (Grok/DeepSeek/Kimi/NVIDIA/Cohere) are exposed in env but out of the launch scope;
  rotate for hygiene, do not pay to keep them live.
- Redis is NOT a runtime requirement for the queue (Postgres-backed polling;
  `backend/src/shared/queue.ts`). It backs only cache/rate-limit with graceful
  in-memory fallback (`backend/src/shared/cache.ts`). Not a launch blocker, but the
  disclosed Redis Cloud password still must be recreated (compromised).

---

## Runtime dependencies

Database:
**BLOCKED** (current production `DATABASE_URL` was disclosed → rotate Supabase
password at the dashboard; no reset, no new DB; keep `DATABASE_SSL=true`; then update
local .env + Railway backend + worker)

Redis:
**NOT_REQUIRED** (cache/rate-limit only with in-memory fallback; queue is
Postgres-backed). Still: recreate the disclosed Redis Cloud password for hygiene.

AI:
**BLOCKED** (4 enabled providers — Anthropic, OpenAI, Gemini, Mistral — plus 5
non-enabled ones all had values disclosed → rotate each at its provider; update
local .env + Railway backend)

Google:
**BLOCKED** (`GOOGLE_CLIENT_SECRET` disclosed → rotate at Google Cloud; update local
.env + Railway backend). Redirect URI set to production both locally and on Railway;
**user must confirm the exact URI** in Google Cloud authorized redirect URIs.

Email:
**DISABLED** (`RESEND_ENABLED=false`). `RESEND_API_KEY` disclosed → revoke/rotate for
future activation; NOT a launch blocker.

Cloudflare:
**NOT_REQUIRED** (DNS/HTTPS only; R2/KV/Worker not required; `STORAGE_PROVIDER=memory`;
env token empty). Revoke the disclosed Cloudflare token at the dashboard; no replacement
needed.

R2:
**NOT_REQUIRED**

KV:
**NOT_REQUIRED**

Payments:
**PASS** — `RAZORPAY_MODE=payment_link` (fixed a malformed local value), Pro ₹999
(`https://rzp.io/rzp/sAgHIpxS`), Team ₹4999 (`https://rzp.io/rzp/3ioXlCxd`);
successful payment → automatic server entitlement; manual admin activation
NOT_REQUIRED; Razorpay API/webhook creds NOT_REQUIRED for Payment Link launch.
No payment made, no architecture change.

Tests (latest full verification; no test code modified):
- Backend: **1728 passed / 1 failed / 3 skipped** (the 1 = known flaky perf-17 timing
  test at `perf-17.test.ts:175` `expected 2608 < 2000`; passes 3/3 in isolation;
  unrelated to credentials)
- Frontend: **279 passed / 0 failed / 0 skipped**
- Shared: **63 passed / 0 failed / 0 skipped**
- Local Agent: **49 passed / 0 failed / 0 skipped**
- Security/config tests: **57 passed** (subset verified after vitest.config cleanup)

Typecheck:
**PASS** (all 4 workspaces)

Build:
**PASS** (shared, backend, local-agent)

---

## Security scan

- Current tracked tree: **CLEAN** (real credentials embedded in
  `backend/vitest.config.ts` were replaced with non-credential placeholders; remaining
  marker matches are only historical docs referencing the decommissioned Upstash
  **host** — a public identifier — with tokens already redacted. `.env` is git-ignored.)
- Reachable history: **CLEAN** (exposed file not present in any reachable commit;
  dangling object left untouched — no rewrite, no force-push.)

---

## Overall

**CREDENTIAL_GATE = BLOCKED** — deployment must not occur until the user:

1. Recreates the **Redis Cloud** password (disclosed) → local `.env` + Railway backend + worker.
2. Rotates the **Supabase** production DB password (disclosed) → local `.env` + Railway backend + worker.
3. Rotates **Anthropic, OpenAI, Gemini, Mistral** keys (disclosed + enabled) → local `.env` + Railway backend.
4. Rotates **Grok, DeepSeek, Kimi, NVIDIA, Cohere** keys (disclosed, not enabled) → hygiene, optional.
5. Rotates **GOOGLE_CLIENT_SECRET** (disclosed) → local `.env` + Railway backend; confirm production redirect URI in Google Cloud.
6. Revokes **RESEND_API_KEY** (disabled) and the **Cloudflare API token** (not required).

After each rotation the user only updates local `.env` (never chat). I then synchronize
the fresh values to Railway without displaying them. Once re-verified that
`OLD_VALUES_REMAIN = NO` and all above are FRESH on both local and Railway, and
Google redirect is confirmed, the gate moves to **PASS**.
