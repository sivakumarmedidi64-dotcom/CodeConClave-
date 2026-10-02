# INTEGRATION EVIDENCE — CodeConClave (2026-09-28; live Render production verified 2026-09-30)

> **Scope note (read before citing).** Everything below was captured against the
> **pre-hardening** live build — deploy `dep-dauhu5psrm7s73cb2te0`, commit `dd997d9`,
> schema chain `0001..0136`. The hardening release that ships with this file adds
> migrations `0138`–`0141` and changes auth (`zero_domain_auth`), object storage
> (`STORAGE_PROVIDER` default `postgres` -> `object_blobs`), health semantics, and
> filesystem/SMB handling. This evidence therefore describes the **previous**
> deployment and must be re-verified against the newly deployed build before it is
> cited as evidence for current production. See `docs/KNOWN_LIMITATIONS.md`.

Real infrastructure only. No fake DBs, no in-memory Redis substitutes, no mocked
RLS/pg. Mocks appear only inside the ordinary unit suite, never in these runs.

## Real-DB two-tenant integration test

Target: real Neon `codeconclave_verify` database, full schema chain `0001..0136`.

Invocation (Windows PowerShell; `DATABASE_URL` loaded from the Railway-managed
verify DB via `make-verify-db.mjs`, never printed):

```
DATABASE_URL=<real> NODE_ENV=test TRUST_PROXY=1 \
  node node_modules/vitest/vitest.mjs run \
    --config backend/vitest.integration.config.ts \
    backend/src/foundation/p0-2-cross-tenant-real.test.ts
```

Result: `Test Files 1 passed` — `Tests 7 passed | 1 skipped`.

The integration config (`backend/vitest.integration.config.ts`) does NOT
override `DATABASE_URL` (the default unit config pins a localhost URL); it
passes the process env through. This is the only difference.

Covered (against real rows, real constraints, real RLS):
- User + workspace creation and cross-tenant identity.
- `workspace_shares` accepts real DB-enforced `mode (WATCH,COMMENT,CO_CONTROL)`
  and `visibility (PUBLIC,PRIVATE)`.
- API key creation enforces the `api` / `PRO_VERIFIED` entitlement
  (`assertApiAccessEntitled`, `backend/src/modules/apikeys/service.ts`).
- The 1 skipped test is a probe gate for a measured gap (no fabricated
  assertion), documented inline; `getUserApiKey` does not exist as an export.

## DB-level RLS role proof (verify DB)

Real login roles `rls_probe_role_a` / `rls_probe_role_b`
(`LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`, `GRANT SELECT` on
`public` schema + `proof_claims`), seeded via tenant users. Results:

| probe | is_tenant_a | is_tenant_b |
| --- | --- | --- |
| a sees rows | `[prf_rls_a]` only | 0 |
| b sees rows | 0 | `[prf_rls_b]` only |
| cross-tenant PK probe | 0 rows | 0 rows |
| no identity | 0 rows | 0 rows |

`ISOLATION_OK=true`. Full cleanup verified (roles/users/rows all 0). Conclusion:
DB-level RLS rejection proven with real non-owner roles; `app.uid()` reads the
`app.current_user_id` GUC, so the honest proof is ownership-scoped visibility.

## Orchestration / schema integrity

- Production vs verify table diff after 0135 convergence:
  `MISSING_IN_PROD=0, EXTRA_IN_PROD=1 [playing_with_neon]` (Neon scratch table).
- `0135_superpowers_chain_convergence.sql` re-applied to verify: idempotent
  no-op (validate-before-nothing, zero errors) — proves replay safety.

## Unit suite (regression gate)

Default config, node on PATH (3 environment-sensitive tests need it):

```
Test Files  226 passed (226)
Tests       4036 passed | 24 skipped (4060)
```

Delta vs earlier baseline: +8 tests covering the webhook rail token gate
(4 route-integration) and the new production config guard (3 + 1 orthogonal).

## New auth gate coverage

- Webhook rail token gate (`INTERNAL_WEBHOOK_TOKEN`): missing token -> 401
  `invalid_internal_token`; wrong token -> 401; correct token + valid HMAC ->
  accepted with the 2s STOP/HOLD window still applied; correct token + bad HMAC
  -> still 401 `invalid_signature` (HMAC remains mandatory).
- Production config guard: webhook enabled + no token -> refuse to boot;
  webhook enabled + token -> starts; webhook disabled -> token not required.

---

## REAL INFRASTRUCTURE CLOSURE PASS — fresh re-run (2026-09-29)

Fresh run today (not a re-cite of prior evidence) against real infrastructure.

### Real PostgreSQL (Neon, PG 18.6, ap-southeast-1)

- Verify DB: `codeconclave_verify_today` (SQL-created on the production Neon
  server, reachable as `neondb_owner`). Full migration chain applied fresh:
  **133/133** `0001..0137`, each sha256-recorded in `schema_migrations`
  (0137 = `2ac0182fac2b`).
- Real two-tenant suites (integration config, real rows, real service modules):
  - `p0-2-cross-tenant-real.test.ts`: **7 passed | 1 skipped**
    (skip = honest probe gate, skipped BECAUSE the DB is live).
  - `p0-2-files-real.test.ts`: **7 passed | 1 skipped**.
  - `p0-2-reviews-real.test.ts`: **8 passed | 1 skipped**.
  - Total: **22 passed | 3 skipped** on real Neon.
- Tenant A cannot list/read/revoke tenant B API keys or shares; workspace
  state and project files/reviews are owner-scoped through the real
  `withTenant` paths (assertions against real rows).

### Production migration (applied through the normal migrator, additive only)

- Before: prod ledger = 132 (`0001..0136`); `audit_logs.success` column
  **absent** (the `logAnalysis.auditErrors` bug was live).
- After: `migrate up` applied exactly `0137_audit_success_column.sql`
  (`sha256 2ac0182fac2b`). Post-DDL real verification:
  - `audit_logs.success` = `boolean NOT NULL DEFAULT true` ✅
  - `idx_audit_logs_success_created` present ✅
  - prod ledger now **133**, 0137 recorded ✅
- Pre-existing (not introduced by this pass) ledger-checksum drift warnings for
  `0079`, `0095`, `0104`, `0128` — historical legacy state, warn-only.

### Real Redis

- NOT provisioned. `railway add -d redis` -> **"Your trial has expired. Please
  select a plan to continue using Railway."** No memory fallback was used.
  `QUEUE_PROVIDER` stays at its Railway value; deploy remains fail-fast.

### Real Redis (2026-09-29) — Upstash Free, TLS verified

- Redirected by budget constraint (₹0) to a REAL managed free Redis: Upstash
  Redis Free (Mumbai region preference not offered at creation; customer account
  default region applied). Native Redis TCP via `ioredis ^5.4.2` (hoisted in
  repo root lockfile — the exact client the deployed cache module uses).
- **TLS requirement proven live**: the pasted connection string was
  `redis://` (non-TLS); Upstash refused it (`Connection is closed`, ~267 ms).
  Upgraded scheme to `rediss://` (same host/port/credentials) ->
  `CONNECTED ping=PONG in 381 ms`. The stored Railway `REDIS_URL` was corrected
  to the TLS form (leading whitespace from the paste was also removed).
- `REDIS_URL` + `QUEUE_PROVIDER=redis` are set on the Railway production service
  (verified present/values via CLI; values never printed).
- Real suite `backend/src/foundation/p0-2-redis-real.test.ts`
  (real Upstash, no mocks): **8 passed | 0 skipped**, including:
  - connectivity PING + set/get/incr/del round-trip
  - MFA consume-once via the REAL `createIdentityMfaChallenge` /
    `verifyIdentityMfaChallenge`; replay -> `mfa_challenge_replayed` ✅
  - replay after a fresh process instance (burned nonce persists: INCR=2) ✅
  - cross-instance atomicity (two real clients, exactly one INCR wins) ✅
  - rate-limit isolation (`rl:auth:*` buckets — Client A cannot move Client B) ✅
  - `QUEUE_PROVIDER=redis`; cache.kind === 'redis' ✅
- Upstash Free constraints recorded as a launch constraint: 256 MB data /
  500K commands/month. No auto-upgrade, no paid dependency added.

### Real email (Resend)

- API key valid (functional domain-scoped error, not 401).
- Controlled real delivery to the account owner: **HTTP 200, id issued,
  provider status `queued`** (test-mode recipient restriction observed:
  without a verified domain, Resend only permits the account-owner address).

### Failure-fail evidence in production

- The Railway service `wholesome-generosity` is `● Failed` with **no logs**
  from its latest deployment — consistent with the config-load fail-fast guard
  (`env.ts` REDIS_URL / QUEUE_PROVIDER production requires), i.e., production
  refuses to boot without real Redis. Guards remain enabled; nothing weakened.

### Final local verification pass (2026-09-29, after Upstash wiring)

| gate | result |
|---|---|
| typecheck (shared, backend, local-agent, frontend, desktop) | **5/5 exit 0** |
| backend unit suite | **230 files, 4041 passed / 54 skipped (4095)**, 0 failed |
| shared suite | 8 files, 70 passed |
| local-agent suite | 5 files, 51 passed |
| desktop suite | 6 files, 66 passed |
| frontend suite | 1 **pre-existing** failure (not introduced by this pass): `src/App.test.tsx` -> "locks the workspace surface when the server reports no entitlement" expects `/no free application tier/i` |
| builds | shared/backend/local-agent tsc exit 0; desktop tsc + bundle-preload + copy-frontend exit 0; frontend `vite build` exit 0 |
| real integration (4 files, PG verify DB + real Upstash) | **29 passed / 4 skipped (33)** — skips are the honest probe-gate tests, skipped because infra is live |

## LIVE PRODUCTION DEPLOYMENT — Render Free (2026-09-30)

Live host: **https://codeconclave-api.onrender.com** (Render Free plan, real
infra, no card, no paid tier). Region Singapore. Service
`srv-da4a58m7bikc73dj0ev0`. Auto-deploy on.

- **Live deploy:** `dep-dauhu5psrm7s73cb2te0`, commit `dd997d9`, status **live**.
- **Boot:** fail-loud guards passed (DB reachable, 0 pending migrations, usable
  payment-link pool) — see `server.ts` `process.exit(1)` paths. The service did
  not start unless every production guard was satisfied.

### Live health (all critical subsystems real and healthy)

`GET /healthz` -> `{"ok":true}` (Render health-gate path). `GET /health`:
`api HEALTHY`, `database HEALTHY` (Neon), `cache HEALTHY` (Upstash Redis),
`queue HEALTHY`, `worker HEALTHY`, `ai HEALTHY`. Non-critical
`NOT_CONFIGURED/DEGRADED` are honest: object storage + Sentry not configured, no
local agent online, some plugins down. `GET /api/v1/health`:
`database healthy, redis healthy, anthropic ok, openai ok`.

### Live database (real Neon `neondb`)

- Live `register` -> **201**, session cookie `cc_session` (Secure+HttpOnly).
- User row written and read back from prod `neondb` (e.g. `usr_t4z0wfpl5wp67bggjbkt`).
- `schema_migrations` = **133**, last `0137_audit_success_column.sql` (matches local ledger).
- RLS: **294/368** public tables have RLS enabled; **327** policies incl.
  `users_self USING (id = app.uid())`, `sessions_self USING (user_id = app.uid())`.
  `force.rls` is unset (normal enforcement). **Honest caveat:** the app connects
  as `neondb_owner`, which has `BYPASSRLS`, so RLS policies are NOT the runtime
  isolation boundary — app-layer tenant scoping is. Verified by live two-tenant
  probe: user A sees only its own session (`ses_7sus7…`), user B only its own
  (`ses_jzkge1…`); zero cross-tenant leakage. **Recommendation (not done — no
  schema change on live DB):** connect with a non-BYPASSRLS role to make RLS
  effective at the DB layer.

### Live security headers / CORS / CSRF

- `strict-transport-security`, strict `content-security-policy`,
  `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy: no-referrer` — all present.
- CORS same-origin only: foreign `Origin` -> **no** `Access-Control-Allow-Origin`
  (browser blocks); own origin -> reflected + credentials. No wildcard.
- CSRF cookie `codeconclave_csrf` issued; protected writes require `x-csrf-token`.

### Live payment (no fabricated events)

- `GET /api/v1/payments/capabilities` (authed) -> `mode payment_link`, INR plans
  (Pro 999 / Team 4999 / API 9999), `webhook enabled:true`. Paid workspace routes
  correctly return **402 entitlement_required** for unpaid users — no entitlements
  fabricated.
- Cloudflare worker `codeconclave-razorpay-webhook-adapter` secret
  `CODECONCLAVE_BACKEND_URL` -> live Render backend. Worker HMAC guard: no
  signature -> 401, bad signature -> 401, wrong path -> 404. Backend internal
  webhook: no bearer -> 401 `invalid_internal_token`; valid bearer + bad signature
  -> 401 `invalid_signature` (token accepted, then signature enforced). Full
  Razorpay->worker->backend chain live and guarded; no synthetic payment event
  was ever sent.

### Live email (real Resend)

- `POST /api/v1/auth/verify-email/send` (authed, live service) -> **200
  `{"sent":true,…}`**; matching `email_verifications` row written to prod DB
  (`2026-09-30T14:27:14Z`, PENDING). Real Resend API delivery from the deployed
  service.

### Desktop (hosted-backend connectivity)

- `desktop` typecheck + build exit 0 (tsc + preload bundle + SPA copy). Packaged
  builds proxy to the hosted backend (`spa-server.ts:34`
  `app.isPackaged ? HOSTED_BACKEND_URL : localhost:4000`); `HOSTED_BACKEND_URL =
  https://codeconclave-api.onrender.com`.

### Build-root-cause fix (why the first live build failed)

First live build failed: `vite build` -> `ERR_MODULE_NOT_FOUND
@vitejs/plugin-react`. Root cause: `@vitejs/plugin-react` is a **devDependency**;
Render runs Node builds with `NODE_ENV=production`, so `npm ci` omitted
devDependencies (installed 437 pkgs, no toolchain). Fix: build with
`npm ci --include=dev` (pinned in `render.yaml`; live service buildCommand
updated to match). Re-deploy built green from a clean clone (791 pkgs, vite +
plugin present). Code unchanged; only the build contract.