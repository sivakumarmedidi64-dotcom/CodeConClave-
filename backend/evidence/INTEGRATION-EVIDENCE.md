# INTEGRATION EVIDENCE — CodeConClave (2026-09-28)

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

### Deploy still blocked (server-side, external action required)

- `railway up` -> **"Your trial has expired. Please select a plan to continue
  using Railway."** (one transient "Deploys have been paused temporarily",
  then the trial-expired error again). The Railway account
  `sivakumarmedidi64@gmail.com` still has no active plan, so the backend cannot
  be deployed. No deployment was submitted; nothing was weakened to work around
  it. Live endpoints, post-deploy email, live Razorpay backend chain, Electron
  hosted-backend connectivity, and the live REDIS_URL-removal boot test remain
  unverified because they require the live host.