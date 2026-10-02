# Secret Rotation Checklist

**Date:** 2026-08-25
**Repository:** `C:\Users\sride\CodeConClave-`
**Incident:** Tracked file `GitHub URL - httpsgithub.commedidis.md` exposed 13 credentials

---

## Rotation Status

| # | Variable/Category | Service | Exposed? | Rotated? | New Value Present? | Verified? |
|---|-------------------|---------|----------|----------|-------------------|-----------|
| 1 | `SESSION_SECRET` | Local app | YES | **YES** | YES (.env) | YES |
| 2 | `JWT_SECRET` | Local app | YES | **YES** | YES (.env) | YES |
| 3 | `ANTHROPIC_API_KEY` | Anthropic | YES | NO | EMPTY | — |
| 4 | `OPENAI_API_KEY` | OpenAI | YES | NO | EMPTY | — |
| 5 | `GEMINI_API_KEY` | Google AI | YES | NO | EMPTY | — |
| 6 | `MISTRAL_API_KEY` | Mistral | YES | NO | EMPTY | — |
| 7 | `REDIS_URL` / Upstash Token | Upstash | YES | NO | EMPTY | — |
| 8 | `RESEND_API_KEY` | Resend | YES | NO | EMPTY | — |
| 9 | `CLOUDFLARE_API_TOKEN` | Cloudflare | YES | NO | EMPTY | — |
| 10 | `GITHUB_CLIENT_SECRET` | GitHub OAuth | YES | NO | EMPTY | — |
| 11 | `SENTRY_DSN` | Sentry | YES | NO | EMPTY | — |
| 12 | DATABASE_PASSWORD | Supabase | YES | NO | EMPTY | — |
| 13 | Supabase Publishable Key | Supabase | YES | NO | EMPTY | — |

**Summary:** 2 of 13 rotated. 11 pending.

---

## Rotation Instructions

For each credential below, go to the specified dashboard, revoke/rotate the old value, and paste the new value directly into `C:\Users\sride\CodeConClave-\.env.production`. Do NOT paste values into chat.

### 1. ANTHROPIC_API_KEY

**Service:** Anthropic
**Dashboard:** https://console.anthropic.com → API Keys
**Action:** REVOKE old key → CREATE NEW key
**Production impact:** AI features (Claude) will fail until updated
**Verification:** New key should return 200 on `GET /v1/models`

### 2. OPENAI_API_KEY

**Service:** OpenAI
**Dashboard:** https://platform.openai.com → API Keys
**Action:** REVOKE old key → CREATE NEW key
**Production impact:** AI features (GPT) will fail until updated
**Verification:** New key should return 200 on `GET /v1/models`

### 3. GEMINI_API_KEY

**Service:** Google AI Studio
**Dashboard:** https://aistudio.google.com → API Keys
**Action:** DELETE old key → CREATE NEW key
**Production impact:** AI features (Gemini) will fail until updated
**Verification:** New key should return 200 on chat completion

### 4. MISTRAL_API_KEY

**Service:** Mistral AI
**Dashboard:** https://console.mistral.ai → API Keys
**Action:** REVOKE old key → CREATE NEW key
**Production impact:** AI features (Mistral) will fail until updated
**Verification:** New key should return 200 on chat completion

### 5. REDIS_URL (Upstash Token)

**Service:** Upstash
**Dashboard:** https://console.upstash.com → Select your Redis instance → Tokens
**Action:** REVOKE old token → CREATE NEW token
**Production impact:** Queue and cache will fail until updated
**Verification:** New URL should respond to `PING` with `PONG`
**Note:** The REDIS_URL contains the token embedded in the connection string. After creating a new token, copy the full `rediss://...` connection string.

### 6. RESEND_API_KEY

**Service:** Resend
**Dashboard:** https://resend.com/api-keys
**Action:** DELETE old key → CREATE NEW key
**Production impact:** Email sending will fail until updated
**Verification:** New key should return 200 on `GET /domains`

### 7. CLOUDFLARE_API_TOKEN

**Service:** Cloudflare
**Dashboard:** https://dash.cloudflare.com → My Profile → API Tokens
**Action:** DELETE old token → CREATE NEW token (with Workers/KV permissions)
**Production impact:** Worker and KV operations will fail until updated
**Verification:** New token should return 200 on `GET /user/tokens/verify`

### 8. GITHUB_CLIENT_SECRET

**Service:** GitHub
**Dashboard:** https://github.com → Settings → Developer settings → OAuth Apps → CodeConClave → Client Secret
**Action:** RESET client secret
**Production impact:** GitHub login will fail until updated
**Verification:** New secret should be accepted by GitHub token endpoint

### 9. SENTRY_DSN

**Service:** Sentry
**Dashboard:** https://sentry.io → Project Settings → Client Keys (DSN)
**Action:** RESET DSN (regenerate)
**Production impact:** Error tracking will fail until updated
**Verification:** Send test event with new DSN

### 10. DATABASE_PASSWORD (Supabase)

**Service:** Supabase
**Dashboard:** https://app.supabase.com → Project → Settings → Database → Reset Database Password
**Action:** PASSWORD RESET (copy new connection string)
**Production impact:** All database connections fail until updated
**Verification:** New password should allow psql connection
**Note:** After reset, update `DATABASE_URL` in `.env.production` with the new full connection string including password.

### 11. Supabase Publishable Key

**Service:** Supabase
**Dashboard:** https://app.supabase.com → Project → Settings → API → anon public
**Action:** REGENERATE publishable key
**Production impact:** Client-side Supabase auth will fail until updated
**Verification:** New key should work with Supabase client

---

## After Rotation

Once all 11 credentials are rotated:

1. Open `C:\Users\sride\CodeConClave-\.env.production` in Cursor
2. Paste each new value into the corresponding empty variable
3. Tell me when done — I will verify all values are present and non-empty
4. Then we proceed with git history cleanup and deployment

---

# FINAL SECRET RESET — 2026-09-05 (CodeConclave PRO, pre-deployment)

**Scope:** `C:\Users\sride\CodeConClave-\.env` (gitignored local runtime env). Values are never printed; this document lists variables/categories/status only.

## App-owned secrets (ROTATED — automated this session)

| Variable | Service | Rotated? | New Value Present? | Verified? |
|----------|---------|----------|--------------------|-----------|
| `SESSION_SECRET` | Local app (session cookie signing) | **YES** — 96-char CSPRNG (hex) | YES (`.env`) | YES (config parse + prod weak-secret guard not triggered) |
| `JWT_SECRET` | Local app (JWT signing) | **YES** — 96-char CSPRNG (hex) | YES (`.env`) | YES |

- `GMAIL_CLAIM_HMAC_SECRET`, `DEMO_SESSION_SECRET` are NOT set in `.env`; their effective derivation keys from `SESSION_SECRET`, so they are covered by the rotation above.
- 88 other lines in `.env` preserved byte-for-byte (writing fingerprint: SHA-256 of regenerated file recorded in opencode evidence, never values).

## External / provider-synced credentials (PRESERVED — human `ROTATION_REQUIRED = YES`)

Because baseline exposure history is UNVERIFIED (git tooling broken, see `SECRET_GIT_HISTORY_STATUS.md`), every externally-issued credential below should be rotated by a human at its provider dashboard before production deployment. Value presence was preserved; **no automated rotation performed** (would break the rail or require provider access).

| Category | Variables | ROTATION_REQUIRED |
|----------|-----------|-------------------|
| AI provider API keys | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `GROK_API_KEY`, `DEEPSEEK_API_KEY`, `KIMI_API_KEY`, `NVIDIA_API_KEY`, `COHERE_API_KEY` | **YES** |
| Email | `RESEND_API_KEY` | **YES** |
| Database | `DATABASE_URL` (required; contains credentials) | **YES** |
| Cache | `REDIS_URL` — **HUMAN_REQUIRED: value is an unparseable URL; `initCache()` throws `Invalid URL` and server boot aborts. Fix or clear the value at the provider / in `.env`.** | **YES** |
| OAuth | `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET`, `GITHUB_PRIVATE_KEY` | **YES** |
| Webhook verification (provider-synced HMAC — do NOT rotate until webhook endpoints receive the new value) | `GITHUB_WEBHOOK_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | **YES** |
| Payment (do NOT rotate automatically) | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | **YES** (human, via Razorpay dashboard) |
| Object storage | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_R2_ACCESS_KEY_ID`, `CLOUDFLARE_R2_SECRET_ACCESS_KEY`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | **YES** |
| Observability | `SENTRY_DSN` (when set) | **YES** |

## Disk / hygiene status (this session, verified)

- Stale secret artifacts: `BAK_SECRET_FILES = 0`, `SHARED_SECRET_TXT = 0`. Only `.env` (required runtime) and `.env.example` (template, placeholder-only) remain at repository root.
- Whole-tree high-confidence pattern scan (excluding `.env*`): **0 real credentials**; the only matches are intentional test fixtures (`backend/src/foundation/control-26g.test.ts`, `backend/src/modules/security-intelligence/security-intelligence.test.ts`) and a known placeholder in `docs/STAGE_26_FINAL_REPORT.md`.
- `secret-scan` (`backend/src/scripts/secret-scan.ts`): **files=827, findings=0, exit 0** after rotation.
- Ignore coverage re-verified in `.gitignore`, `.dockerignore`, `.railwayignore`, all three contain `.env` / `.env.*` / `!.env.example` / `*.txt`.
- Git tracking/history status: **UNVERIFIED** (git binary on this host is broken — `BUG (fork bomb)`). See `docs/SECRET_GIT_HISTORY_STATUS.md`. Do not claim the repository is clean until a working git confirms it.

## After this reset

1. Human rotates every `ROTATION_REQUIRED = YES` credential at its provider dashboard (outlined per-category above).
2. Human fixes `REDIS_URL` (valid Redis connection string) or removes the variable to fall back to the documented in-memory cache/dev path.
3. Re-run `npm run secret:scan`, backend+frontend typecheck/build, `prove:payment`, and this check page before deploy (see `docs/HUMAN_PRE_DEPLOYMENT_SECURITY_CHECKLIST.md`).
