# CODECONCLAVE PRO — FINAL SECRET EXPOSURE REMEDIATION GATE

Security-remediation verification for the incident where live Redis Cloud and Railway
credentials were disclosed in a tool transcript. **No secret values appear in this file.**

Last updated: 2026-08-29. This is a verification/classification report; deployment
remains BLOCKED.

---

## Redis

- Required at runtime: **NO**
  - Actual runtime: Redis backs the cache/rate-limit store only
    (`backend/src/shared/cache.ts:78-135`). `createCache()` **gracefully degrades to an
    in-memory store** when `REDIS_URL` is unset, ioredis is unavailable, or the
    connection fails (`backend/src/shared/cache.ts:79-108`).
  - The task queue is **Postgres-backed polling** (`backend/src/shared/queue.ts`:
    "QUEUE_PROVIDER is an optimization only"; `enqueueTask` is a no-op). BullMQ is
    **not installed** (`node_modules/bullmq` absent) and not a runtime dependency.
  - Therefore Redis is NOT a deployment blocker. Fresh Redis is configured anyway.
- Old credential (Upstash): **INACTIVE**
  - Railway backend + worker `REDIS_URL` verified pointing at the new provider host
    (`prose-tail-crayon-89561.db.redis.io`), NOT Upstash (host-only check, values
    never printed). Old Upstash token was decommissioned.
- Fresh credential: **READY but credential exposed in transcript → must be re-created**
  - A fresh Redis Cloud password was disclosed in the transcript during an earlier
    step. Treat as compromised. **Action: rotate/recreate it in the Redis Cloud
    dashboard, then update .env and (Railway backend + worker).**
- Connectivity: locally verified `PING → PONG` (Redis 8.6.2) with the app-identical
  ioredis options over `redis://` (plain TCP). TLS (`rediss://`) fails on this port.

---

## Database

- Credential exposed: **YES**
  - The current production Supabase `DATABASE_URL` (containing the prod DB password)
    was printed in the Railway variable dump in the transcript.
- Rotation required: **YES**
  - The user must rotate the current production Supabase database password at the
    Supabase dashboard (do NOT reset the database, do NOT create a new one), then
    update local `.env`, Railway backend, and Railway worker.
- Status: **BLOCKED** (pending user rotation)
- Keep `DATABASE_SSL=true` (present on Railway backend + worker).

---

## AI

Providers enabled at runtime: `AI_PROVIDERS_ENABLED = anthropic,openai,google,mistral`
(i.e., Anthropic, OpenAI, Gemini, Mistral).

- Anthropic — **EXPOSED_AND_REQUIRES_ROTATION** (value printed in transcript; also in
  tracked `backend/vitest.config.ts` — now replaced with placeholder)
- OpenAI — **EXPOSED_AND_REQUIRES_ROTATION**
- Gemini — **EXPOSED_AND_REQUIRES_ROTATION**
- Mistral — **EXPOSED_AND_REQUIRES_ROTATION**
- Grok — **EXPOSED_AND_REQUIRES_ROTATION** (listed in env but NOT in
  AI_PROVIDERS_ENABLED → outside current launch scope)
- DeepSeek — **EXPOSED_AND_REQUIRES_ROTATION** (not enabled)
- Kimi — **EXPOSED_AND_REQUIRES_ROTATION** (not enabled)
- NVIDIA — **EXPOSED_AND_REQUIRES_ROTATION** (not enabled)
- Cohere — **EXPOSED_AND_REQUIRES_ROTATION** (not enabled)
- DashScope/North — **NOT_USED / NOT_PRESENT** in this runtime

Counts for this launch:
- 9 exposed (all printed in transcript) → 0 rotated yet → **BLOCKED pending user**
- 4 enabled (Anthropic, OpenAI, Gemini, Mistral) are the launch-critical ones.
- Rotate all 9 at their provider dashboards; then update `.env` and Railway.

Note: these exact values were also embedded in the tracked test fixture
`backend/vitest.config.ts`; those have been replaced with non-credential placeholders
(this session), removing them from the tracked tree.

---

## Google

- Client secret exposed: **YES** (printed in transcript; also in
  `backend/vitest.config.ts` — now replaced with placeholder)
- Rotation: **REQUIRED** (rotate `GOOGLE_CLIENT_SECRET` at Google Cloud, then update
  .env + Railway backend)
- Redirect: code route is **correct** — `GET /api/v1/auth/google/callback`
  (`backend/src/modules/auth/routes.ts:328` under the `/api/v1/auth` mount at
  `backend/src/app.ts:193`). `GOOGLE_REDIRECT_URI` is set in local `.env` and Railway
  backend to `https://backend-production-95faa.up.railway.app/api/v1/auth/google/callback`.
  **User action:** confirm this exact URI is listed in Google Cloud OAuth authorized
  redirect URIs (https://console.cloud.google.com/apis/credentials). Terminal-state not
  verifiable from here → mark Redirect: PASS only after user confirmation.
- `GOOGLE_CLIENT_ID` is a public identifier (non-secret), no rotation.

## Resend

- Credential exposed: **YES** (printed in transcript; also in
  `backend/vitest.config.ts` — now replaced with placeholder)
- `RESEND_ENABLED = false` → **DISABLED / OPTIONAL** at runtime.
- Rotation: still recommended since the value was exposed; not a launch blocker.
- Status: **OPTIONAL** (rotate to be safe, but email sending is disabled in launch).

## Cloudflare

- **NOT_REQUIRED** at runtime: all `CLOUDFLARE_*` env vars are optional
  (`backend/src/config/env.ts:100-110`); `STORAGE_PROVIDER = memory`;
  `CLOUDFLARE_API_TOKEN` is empty in `.env`; no non-test runtime usage of R2/KV.
- The previously exposed Cloudflare API token is not configured in the current launch.
  **Action: revoke it at the Cloudflare dashboard** and leave the integration
  disabled/optional. No R2/KV/Workers purchase needed.

## Payment

- Mode: `RAZORPAY_MODE = payment_link` (fixed this session — the local `.env` had a
  malformed value `paymtment link` which would have failed zod enum validation at
  startup; restored to `payment_link`).
- Pro = ₹999 (`https://rzp.io/rzp/sAgHIpxS`) — **PASS**
- Team = ₹4999 (`https://rzp.io/rzp/3ioXlCxd`) — **PASS**
- Normal successful payment → automatic server-side entitlement activation
  (exactly-once guard, `backend/src/modules/payments/activation.ts`). Manual admin
  activation: **NOT_REQUIRED** (the only path to ACTIVE is the activation matcher).
- Razorpay API/webhook credentials: `RAZORPAY_KEY_ID/SECRET/WEBHOOK_SECRET` are all
  empty — **NOT_REQUIRED** for the current payment-link launch.
- No payment/architecture changes made. Status: **PASS**.

## Git

- Current tracked tree: **CLEAN**
  - `backend/vitest.config.ts` real credentials (Google client secret, 9 AI keys,
    Resend key) replaced with non-credential placeholders this session.
  - Broad scan: remaining matches are fake test fixtures (`AKIA…`, `sk_live_…`,
    `xai-test`, etc.) and false positives — documented as non-credential by
    `docs/STAGE_26_FINAL_REPORT.md`.
  - Historical docs reference only the decommissioned Upstash **host** (public
    identifier); tokens there are already redacted.
  - `.env` is git-ignored (verified).
- Git history: **CLEAN in reachable history**
  - The exposed file is not present in any reachable commit (`git log --all` for the
    exposed path returns nothing). A dangling object (`d6743fb`) may remain in the pack
    but is unreachable. **Not rewritten, not force-pushed** (as instructed).

## Tests

- Backend: **1728 passed / 1 failed / 3 skipped** (full suite run)
  - The 1 failure is the **known flaky perf-17 timing test** —
    `perf-17.test.ts:175` `AssertionError: expected 2608 to be less than 2000`
    (PHASE 17 performance smoke: full 2-stage pipeline wall-clock measurement).
    It **passes in isolation (3/3)** and is unrelated to this remediation (it is a
    machine-load timing measurement, not logic). Documented, not modified.
- Frontend: **279 passed / 0 failed / 0 skipped**
- Shared: **63 passed / 0 failed / 0 skipped**
- Local Agent: **49 passed / 0 failed / 0 skipped**

## Typecheck

- **PASS** (all 4 workspaces: backend, frontend, local-agent, shared)

## Build

- **PASS** (shared, backend, local-agent)

---

## Overall

- **BLOCKED** — deployment must NOT occur until the user:
  1. Rotates/recreates the Redis Cloud password (disclosed in transcript) and re-syncs
     .env + Railway backend + worker.
  2. Rotates the production Supabase DB password (disclosed in transcript) and re-syncs
     .env + Railway backend + worker.
  3. Rotates the 9 AI provider keys (disclosed in transcript) and re-syncs
     .env + Railway.
  4. Rotates `GOOGLE_CLIENT_SECRET` (disclosed in transcript) and re-syncs
     .env + Railway backend; confirms the production redirect URI in Google Cloud.
  5. (Optional) rotates `RESEND_API_KEY` (disabled) and revokes the Cloudflare API token
     if still extant.
  - After each, re-verify freshness, then the gate can move to PASS.

Session-completed remediations: Redis provider swapped to Redis Cloud (fresh base, but
that credential now needs re-creating due to disclosure); SESSION_SECRET + JWT_SECRET
already fresh locally and synced to Railway backend (worker does not require them);
production GOOGLE_REDIRECT_URI set locally + Railway backend; `RAZORPAY_MODE`
malformed value corrected to `payment_link`; tracked real credentials in
`backend/vitest.config.ts` replaced with placeholders; tests/typecheck/build re-run.
