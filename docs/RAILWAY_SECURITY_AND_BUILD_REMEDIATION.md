# RAILWAY SECURITY AND BUILD REMEDIATION

Security-critical remediation for the CodeConClave Pro Railway backend.
INSPECT → SECURE → CONFIGURE → VERIFY. No secrets are stored in this file.
All sensitive values are reported only as status (PRESENT / MISSING / OLD / ROTATION_REQUIRED).

---

## Railway

| Field | Value |
|---|---|
| Project | CodeConClave (`82dd1698-e7f6-4912-8cd6-299a1bc95557`) |
| Environment | production (`2957bdcd-e168-4e8a-b9c5-04a817221843`) |
| Backend service | backend (`25f5893f-75c5-4c83-996f-e025f8ebd70e`) |
| Public domain | `https://backend-production-95faa.up.railway.app` |

- No new backend service created (existing one reused).
- Worker and frontend services exist but are NOT deployed in this phase.

---

## Build Configuration

Applied to the backend service via the Railway GraphQL API
(`serviceInstanceUpdate`). Confirmed returned `true` and re-queried:

| Setting | Value | Status |
|---|---|---|
| Root directory | `/` | CONFIGURED |
| Build command | `npm ci && npm run build --workspace @codeconclave/shared && npm run build --workspace @codeconclave/backend` | CONFIGURED |
| Start command | `npm run start --workspace @codeconclave/backend` | CONFIGURED (verified via query) |
| Port | 4000 (from env `PORT=4000`) | CONFIGURED |
| Health (primary) | `/healthz` (healthcheckPath, timeout 30) | CONFIGURED |
| Health (detailed) | `/health` | CONFIGURED (existing endpoint) |

Prior failure cause:
- Backend Build Command / Start Command were UNSET (null), so Railpack auto-detected the
  root `npm run build`, whose `prebuild: npm ci` failed with
  `EBUSY rmdir /app/frontend/node_modules/.vite` (exit 240). This was a stale
  build-cache lock, NOT a source defect. Backend was already `● Failed` before this session.

After pinning the explicit build/start commands the auto-detection path is avoided.

---

## Credentials

Requirement: any value that was present in Git commit `d6743fb`
(file `GitHub URL - httpsgithub.commedidis.md`) is considered COMPROMISED and must be rotated.

Comparison of current Railway variables against the local `.env`
(file `C:\Users\sride\CodeConClave-\.env`) was performed WITHOUT printing values.

### STATUS (no values)

| Variable | Required | Railway | Local .env | Status |
|---|---|---|---|---|
| SESSION_SECRET | Required | PRESENT | PRESENT | OLD_VALUE_STILL_PRESENT — ROTATION_REQUIRED |
| JWT_SECRET | Required | PRESENT | PRESENT | OLD_VALUE_STILL_PRESENT — ROTATION_REQUIRED |
| DATABASE_URL | Required | PRESENT | PRESENT | OLD_VALUE_STILL_PRESENT — ROTATION_REQUIRED |
| REDIS_URL | Required | MISSING | PRESENT | MISSING_IN_RAILWAY — VERIFY_FRESH_THEN_ADD |
| ANTHROPIC_API_KEY | Optional | PRESENT | PRESENT | OLD_VALUE_STILL_PRESENT — ROTATION_REQUIRED |
| OPENAI_API_KEY | Optional | PRESENT | PRESENT | OLD_VALUE_STILL_PRESENT — ROTATION_REQUIRED |
| GEMINI_API_KEY | Optional | PRESENT | PRESENT | OLD_VALUE_STILL_PRESENT — ROTATION_REQUIRED |
| MISTRAL_API_KEY | Optional | PRESENT | PRESENT | OLD_VALUE_STILL_PRESENT — ROTATION_REQUIRED |
| GROK_API_KEY | Optional | PRESENT | PRESENT | OLD_VALUE_STILL_PRESENT — ROTATION_REQUIRED |
| DEEPSEEK_API_KEY | Optional | PRESENT | PRESENT | OLD_VALUE_STILL_PRESENT — ROTATION_REQUIRED |
| KIMI_API_KEY | Optional | PRESENT | PRESENT | OLD_VALUE_STILL_PRESENT — ROTATION_REQUIRED |
| NVIDIA_API_KEY | Optional | PRESENT | PRESENT | OLD_VALUE_STILL_PRESENT — ROTATION_REQUIRED |
| COHERE_API_KEY | Optional | PRESENT | PRESENT | OLD_VALUE_STILL_PRESENT — ROTATION_REQUIRED |
| RESEND_API_KEY | Optional | PRESENT | PRESENT | OLD_VALUE_STILL_PRESENT — ROTATION_REQUIRED |
| GOOGLE_CLIENT_ID | Optional | PRESENT | PRESENT | OLD_VALUE_STILL_PRESENT — ROTATION_REQUIRED |
| GOOGLE_CLIENT_SECRET | Optional | PRESENT | PRESENT | OLD_VALUE_STILL_PRESENT — ROTATION_REQUIRED |
| GOOGLE_REDIRECT_URI | If OAuth | MISSING | PRESENT | MISSING_IN_RAILWAY — VERIFY_FRESH_THEN_ADD |
| RAZORPAY_KEY_ID/SECRET/WEBHOOK | Not required (payment_link) | ABSENT | n/a | NOT_REQUIRED |
| CLOUDFLARE/R2/KV/S3 | Not required (STORAGE_PROVIDER=memory) | ABSENT | n/a | NOT_REQUIRED |

### KEY FINDING

The local `.env` currently contains the SAME values as Railway for every leaked
credential. **The credentials have NOT yet been rotated.** Both local `.env` and
Railway still hold the values that were exposed in commit `d6743fb`.

Therefore:
- These values must NOT be propagated to any environment.
- Production deploy is BLOCKED until every compromised value is regenerated.

### Credential summary

- Required: SESSION_SECRET, JWT_SECRET, DATABASE_URL, REDIS_URL (Google OAuth vars if enabled)
- Present on Railway: all listed except REDIS_URL and GOOGLE_REDIRECT_URI
- Missing on Railway: REDIS_URL, GOOGLE_REDIRECT_URI
- Old leaked values remaining: ALL of the above present credentials (ROTATION_REQUIRED)
- Not required for current launch: Razorpay API/webhook, Cloudflare R2/KV, S3

### Required user action (no values in chat)

1. Regenerate every compromised credential to a FRESH value.
2. Update the local `.env` first, then push each to Railway
   (dashboard → backend → Variables, or `railway variable set`).
3. Do NOT copy `.env` values to Railway until they are confirmed fresh.
4. After rotation, re-run this comparison before deploying.

---

## External Services

| Service | Provider | Status |
|---|---|---|
| PostgreSQL | Supabase (external) | Configured via DATABASE_URL; DATABASE_SSL=true. Not reset, not created. |
| Redis | Upstash (external) | REDIS_URL missing on Railway — add after verifying fresh. QUEUE_PROVIDER=redis present. |
| Cloudflare | not used | No R2/KV/Workers at runtime (STORAGE_PROVIDER=memory). |
| R2 | not used | Not provisioned. |
| KV | not used | Not provisioned. |

No Railway PostgreSQL or Railway Redis created.

---

## Payment

| Item | Value |
|---|---|
| Mode | RAZORPAY_MODE=payment_link |
| Pro (₹999) | https://rzp.io/rzp/sAgHIpxS |
| Team (₹4999) | https://rzp.io/rzp/3ioXlCxd |
| Normal successful payment | automatic server-side entitlement |
| Manual admin activation | not required |
| Razorpay API/webhook creds | NOT required for current Payment Link launch |

Architecture not modified. No real payment made.

---

## Tests

- Typecheck: PASS (shared 0 errors, backend 0 errors)
- Build: PASS (shared, backend)
- Tests: PASS (backend 1728 passed / 3 skipped; 1 documented flaky perf-17
  reproduced only under full-suite parallel load — passes in isolation, 3/3)
- No tests weakened.

---

## Deployment

- Build configuration: READY (pinned to verified commands)
- SSH/git source deploy: UNAVAILABLE (source repo unreachable; local CLI `railway up` is the deploy path)
- Credentials: BLOCKED (rotation still required)
- EBUSY: NOT_TESTED after config change (deploy deliberately not run)
- Overall: **BLOCKED** until credential rotation completes, then re-apply EBUSY test.
