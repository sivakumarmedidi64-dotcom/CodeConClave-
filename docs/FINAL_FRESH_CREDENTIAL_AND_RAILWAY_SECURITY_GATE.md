# FINAL FRESH CREDENTIAL AND RAILWAY SECURITY GATE

Security/credential configuration only. No deployment. No secret values stored here.
All values reported as status only. Audit of the ACTUAL historical leak (`d6743fb`,
file `GitHub URL - httpsgithub.commedidis.md`) was performed to correct over-broad claims.

---

## Historical REAL secrets (in d6743fb) — classification

| # | Variable / Service | In leak? | Status | Rotation |
|---|---|---|---|---|
| 1 | SESSION_SECRET | YES | Rotated fresh locally (128-char) | DONE (local) |
| 2 | JWT_SECRET | YES | Rotated fresh locally (128-char) | DONE (local) |
| 3 | REDIS_URL / Upstash token | YES | **STILL matches exposed token in .env** | **REQUIRED (blocker)** |
| 4 | ANTHROPIC_API_KEY | YES | Current value DIFFERS from leak | VERIFY fresh |
| 5 | OPENAI_API_KEY | YES | Current value DIFFERS from leak | VERIFY fresh |
| 6 | GEMINI_API_KEY | YES | Current value DIFFERS from leak | VERIFY fresh |
| 7 | MISTRAL_API_KEY | YES | Current value DIFFERS from leak | VERIFY fresh |
| 8 | RESEND_API_KEY | YES | DIFFERS from leak; RESEND_ENABLED=false | VERIFY (email off) |
| 9 | CLOUDFLARE_API_TOKEN | YES | EMPTY in .env / not on Railway | NOT_USED (revoke at CF) |
| 10 | SENTRY_DSN | YES | DIFFERS; SENTRY_ENABLED=false | NOT a blocker |
| 11 | Supabase DB password | OLD project | Current prod uses a DIFFERENT Supabase project | VERIFY current prod |
| 12 | Supabase publishable key | OLD project | Leak project differs from prod project | OPTIONAL |
| 13 | GITHUB_CLIENT_SECRET | YES | GitHub plugin OPTIONAL | NOT a launch blocker |

## NON-SECRET / PUBLIC_IDENTIFIER (do NOT rotate)
GitHub repo URL, Cloudflare Worker name/URL, Supabase project URL, Cloudflare R2
Account ID, Razorpay payment links (₹999 / ₹4999).

## OPTIONAL / NOT_USED (in .env but NOT in the leak — no incident rotation)
GROK, DEEPSEEK, KIMI, NVIDIA, COHERE API keys (not in d6743fb).
Razorpay API/webhook secrets (RAZORPAY_MODE=payment_link → not required).
Cloudflare R2/KV/S3 (STORAGE_PROVIDER=memory → not required).

---

## Local .env actions completed

- **SESSION_SECRET = FRESH** (new 128-char, VALUES_DIFFERENT=YES)
- **JWT_SECRET = FRESH** (new 128-char, VALUES_DIFFERENT=YES)
- **GOOGLE_REDIRECT_URI = PRODUCTION** (was `http://localhost:4000/...`, now
  `https://backend-production-95faa.up.railway.app/api/v1/auth/google/callback`)
- Values never printed.

## Local .env remaining (user action required)

- **REDIS_URL = OLD (STILL EXPOSED)** — must be replaced with a fresh Upstash token.
- AI keys = present, differ from the leak — user should confirm these are the intended
  fresh production keys.
- GOOGLE_CLIENT_SECRET — not in the leak; no unnecessary rotation.
- Production GOOGLE_REDIRECT_URI must also be added to the Google Cloud OAuth console
  authorized redirect URIs.

---

## Railway

Backend service `25f5893f...` (build/start/root/port/health already pinned — see
`RAILWAY_SECURITY_AND_BUILD_REMEDIATION.md`). Public URL:
`https://backend-production-95faa.up.railway.app`.

| Variable | Railway | Local .env | Note |
|---|---|---|---|
| SESSION_SECRET | OLD | FRESH (rotated) | SYNC fresh to Railway |
| JWT_SECRET | OLD | FRESH (rotated) | SYNC fresh to Railway |
| DATABASE_URL | OLD | not exposed (diff project) | VERIFY + SYNC |
| REDIS_URL | MISSING | OLD (exposed) | Add FRESH after rotation |
| DATABASE_SSL | true | true | OK |
| QUEUE_PROVIDER | redis | memory | sync to redis |
| GOOGLE_REDIRECT_URI | MISSING | PRODUCTION | Add to Railway |
| AI keys | old/mixed | differ from leak | SYNC confirmed fresh |

Railway credentials: MISSING (fresh sync pending)
Worker credentials: MISSING (needs sync after backend)

---

## External services

| Service | Status |
|---|---|
| Supabase | Pass config (DATABASE_SSL=true); current prod project differs from leaked project |
| Upstash | BLOCKED — current token still the exposed one; fresh token required |
| Cloudflare / R2 / KV | NOT_USED (STORAGE_PROVIDER=memory); no purchase |
| Email (Resend) | not enabled (RESEND_ENABLED=false) |

---

## Payment (unchanged, verified)

- RAZORPAY_MODE=payment_link
- Pro ₹999 = https://rzp.io/rzp/sAgHIpxS
- Team ₹4999 = https://rzp.io/rzp/3ioXlCxd
- Normal success → automatic server entitlement; manual admin NOT required.
- Razorpay API/webhook secrets NOT required for this launch.

---

## Tests / typecheck / build

- Backend: 1728 passed / 3 skipped / 1 flaky (perf-17 — passes in isolation 3/3)
- Frontend: 279 passed / 0 failed
- Shared: 63 passed / 0 failed
- Local-Agent: 49 passed / 0 failed
- Typecheck: PASS (all 4 workspaces)
- Build: PASS

---

## Secret safety scan (working tree, tracked content)

Found and REDACTED exposed marker values in tracked files:
- `backend/vitest.config.ts:95` — contained the real leaked Sentry DSN
  (test env dummy) → replaced with a non-credential placeholder.
- `docs/FINAL_BLOCKER_REMEDIATION_AND_RECHECK.md` (lines 29-30) — contained the
  full exposed Upstash REDIS_URL/token → token redacted.
- `docs/FINAL_GIT_HISTORY_SANITIZATION_REPORT.md` (lines 29-30) — same →
  token redacted.

Result: `git grep` for all 8 known exposed markers → **CLEAN** (no matches) in
tracked content. Verified security tests still pass (42/42).

---

## Deployment / gate

- CREDENTIAL_GATE: BLOCKED
- Remaining blocker: REDIS_URL/Upstash token still exposed; fresh provider keys +
  Railway sync not finalized by user.
- DEPLOYMENT: BLOCKED. Do NOT deploy until:
  - REDIS_URL is fresh in .env and added to Railway
  - Railway SESSION_SECRET/JWT_SECRET updated to the fresh values
  - Railway GOOGLE_REDIRECT_URI set to production
  - Google Cloud console has the production redirect URI
  - all compromised provider tokens revoked

---

## Session update: Redis provider replaced (Upstash → Redis Cloud)

Following the user request "replace Upstash with a fresh Redis provider":

- **Old Upstash decommissioned (no upgrade bought).** New provider: **Redis Cloud**
  (`prose-tail-crayon-89561.db.redis.io:17292`), a fresh instance the user created.

### App Redis requirements verified
- Standard Redis TCP protocol via **ioredis** (backend/src/shared/cache.ts) using
  `env.REDIS_URL` with `{maxRetriesPerRequest:2, lazyConnect:true, commandTimeout:10000}`.
- Scheme validated as `redis://` or `rediss://` (backend/src/modules/deployment-wizard/secretHandling.ts:103).
- **BullMQ: NOT installed and NOT used at runtime** (`node_modules/bullmq` absent; not a
  backend dependency). Queue is Postgres-backed polling (backend/src/shared/queue.ts —
  "QUEUE_PROVIDER is an optimization only"; enqueueTask is a no-op). Redis is cache/rate-limit only.

### Compatibility test (this provider)
- `rediss://` (TLS) → **FAIL** (`SSL routines: wrong version number` on port 17292).
- `redis://` (plain TCP) → **PASS** — `PING → PONG`, Redis 8.6.2.
- Chose **`redis://` (plain)** to match the provider. Verified with the app-identical
  ioredis options: final `PING → PONG`.

### Configured
- **Local `.env`:** fixed a malformed line (the user's paste included a `redis-cli -u `
  prefix and had `QUEUE_PROVIDER=memory` merged onto the REDIS_URL line). Now:
  `REDIS_URL=redis://…` (clean, semantic) and `QUEUE_PROVIDER=redis` on its own line.
- **Railway backend** (`25f5893f…`): `REDIS_URL` (was MISSING) set to fresh value;
  `GOOGLE_REDIRECT_URI` set to https://backend-production-95faa.up.railway.app/api/v1/auth/google/callback.
- **Railway worker** (`2cd27417…`): `REDIS_URL` (was the OLD exposed Upstash
  `gQAAAAAAAtIl…@polished-mammoth-184869.upstash.io`) REPLACED with the fresh value.
- `QUEUE_PROVIDER=redis` already on both backend and worker.

### Verified old Upstash removed
- Railway backend + worker `REDIS_URL` hosts now = `prose-tail-crayon-89561.db.redis.io:17292`
  (host-only check; credentials never displayed). `OLD_UPSTASH = NO` on both services.
- Local `.env` REDIS_URL host likewise non-Upstash; no Upstash token in live config.
- Upstash references remain ONLY in historical incident/checklist docs (all tokens
  already redacted as `<REDACTED_EXPOSED_TOKEN>`).

### Security disclosures that occurred during this task (session transcript)
1. A `grep` of the git-ignored `.env` (matched via `*.env`) echoed the **fresh Redis Cloud
   password** into the transcript (redacted nowhere). **Action: rotate the Redis Cloud
   password** so the disclosed value is dead.
2. An initial `railway variables` inspection printed the full secret set (AI keys, DB
   password, Google client secret, and the **exact leaked Upstash token**) into the
   transcript before I switched to host-only output. The Upstash token is being
   decommissioned anyway, but the other printed values (Railway's live AI/DB/Google
   secrets) were exposed in-session. **Action: decide whether to rotate Railway's live
   secrets** — recommended for any that appeared verbatim.

### Status
- `REDIS_PROVIDER = Redis Cloud`
- `REDIS_URL = FRESH`
- Railway backend + worker `REDIS_URL` = fresh (old Upstash removed)
- Local connectivity = PASS (PING/PONG, app-identical opts)
- BullMQ = N/A (not installed/used; queue is Postgres-backed)
- DEPLOYMENT = still BLOCKED until Railway SESSION_SECRET/JWT_SECRET are synced to the
  freshly rotated local values and the disclosed credentials are rotated.
