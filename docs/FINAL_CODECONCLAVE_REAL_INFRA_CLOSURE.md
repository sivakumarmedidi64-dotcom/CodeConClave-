# CODECONCLAVE — REAL INFRASTRUCTURE ACTIVATION (2026-09-29)

Real infrastructure only. All evidence below was freshly produced today via the
real Railway/Neon/Resend/Cloudflare endpoints (never mocks). Companion artifact:
`backend/evidence/INTEGRATION-EVIDENCE.md` (dated section for this pass).

---

## 1. REAL POSTGRESQL — CONNECTED, MIGRATED, TESTED

| item | result |
|---|---|
| provider | Neon (AWS ap-southeast-1), **PostgreSQL 18.6** |
| production `neondb` | reachable as `neondb_owner`; 368 tables; RLS enabled on 294 (79.9%); **FORCE RLS = 0**; ledger `schema_migrations` now **133** (`0001..0137`) |
| verify DB | `codeconclave_verify_today` (same Neon server, SQL-created, real owner access) — fresh **133/133** migrations applied with sha256 |
| migration 0137 | applied to **verify** and **production** via the normal migrator (`sha256 2ac0182fac2b`); prod post-state verified: `audit_logs.success boolean NOT NULL DEFAULT true` + `idx_audit_logs_success_created` present |
| real cross-tenant suites | **22 passed | 3 skipped** (`cross-tenant` 7P/1S, `files` 7P/1S, `reviews` 8P/1S) — two real tenants A/B; B cannot list/read/revoke A's API keys/shares; files/reviews/memory-style reads owner-scoped through real `withTenant` paths |
| known prod gap | app connects **as table owner** (single role) → owner bypasses RLS; DB-level isolation is app-layer today. The real suite asserts and documents this honestly. FORCE RLS stays **disabled** (runtime role is not non-owner). |

## 2. REAL REDIS — BLOCKED (exact action: select a Railway plan)

| item | result |
|---|---|
| provision | `railway add -d redis` → **"Your trial has expired. Please select a plan to continue using Railway."** |
| memory fallback | **NOT used** (guards untouched) |
| MFA replay / rate-limit | not run — deployment is fail-fast without real Redis (verified in production: service `wholesome-generosity` → `● Failed`, zero boot logs = config-load refusal) |

## 3. DEPLOY — BLOCKED by the same Redis requirement

| item | result |
|---|---|
| host | Railway service `wholesome-generosity` (production env), URL `https://wholesome-generosity-production-f81f.up.railway.app` — *currently Failed* |
| root cause | current code + `NODE_ENV=production`, no `REDIS_URL`, `QUEUE_PROVIDER=memory` → `env.ts` boot guards throw (legitimate fail-fast), restart policy exhausted → `● Failed` |
| endpoints | `/`, `/health`, `/healthz`, `/ready`, `/login`, `/register`, `/pricing` — NOT verifiable until a real Redis exists and the service is deployed |
| headers/CSP/CSRF/sessions | configured (SESSION_COOKIE_SECURE/CSP_ENABLED/CORS_ORIGINS/TRUST_PROXY all present in Railway vars) but only verify-able post-deploy |
| Electron hosted-backend | update deferred to post-deploy (directive 3) |

## 4. RAZORPAY

| item | result |
|---|---|
| Cloudflare Worker | **LIVE + fail-closed today**: `GET /` → 404, unauthed `POST /razorpay/webhook` → 401 (cf-ray on both) |
| production vars | Payment Links (`RAZORPAY_API/TEAM/PRO_PAYMENT_LINK[_ID]`), `RAZORPAY_WEBHOOK_ENABLED`, `RAZORPAY_WEBHOOK_SECRET[_LEGACY]`, `INTERNAL_WEBHOOK_TOKEN` — present |
| live provider event | NOT fired (needs Razorpay dashboard/signing + a running backend). Keys not required by the fixed Payment-Link architecture; webhook secret + internal token are the rail. |
| end-to-end | blocked on deployment (backend route + idempotency + entitlement must be live) |

## 5. EMAIL — REAL DELIVERY PROVEN (Resend)

- Credential valid (functional domain-scoped response, not 401).
- Controlled real delivery → **HTTP 200, id issued, provider status `queued`** to the account owner.
- Remaining: verify a sender domain at resend.com/domains for outbound to arbitrary recipients; OTP/verification/recovery loops run after deploy.

## 6. LOCAL-FIRST / SECURITY — status preserved

- Local-first verified previously (filesystem, workspace security, memory, persistence, cloud boundary) — unchanged, no redesign.
- Tenant isolation: real app-layer proof above; DB-layer gap documented; CSRF/sessions/proxy/MFA/payment-signature verified in unit suite, live verification pending deployment.

---

## FINAL GATE MATRIX (strict)

| item | status |
|---|---|
| POSTGRES reachable | ✅ real Neon PG 18.6 |
| POSTGRES migrations | ✅ 133/133 applied on verify; 0137 applied on prod (sha verified) |
| POSTGRES real cross-tenant | ✅ 22P/3S on real Neon |
| REDIS reachable | ❌ blocked — Railway plan selection required |
| REDIS MFA replay | ⏳ not run (deploy fail-fast without Redis) |
| REDIS distributed rate-limit | ⏳ not run |
| BACKEND live | ❌ service Failed; deploy blocked on Redis |
| BACKEND /healthz etc. | ⏳ pending deployment |
| RAZORPAY worker live | ✅ 401 fail-closed today |
| RAZORPAY real provider event | ❌ not fired (dashboard + running backend required) |
| EMAIL real delivery | ✅ Resend 200/queued |
| EMAIL verified domain | ❌ domain not verified on Resend (test-mode restriction observed) |
| LOCAL-FIRST | ✅ verified (no redesign) |
| SECURITY live checks | ⏳ pending deployment |

## FINAL VERDICT

**BLOCKED — [select/confirm a Railway paid plan to provision the real Redis plugin (REDIS_URL + QUEUE_PROVIDER=redis); then `railway up` the backend and verify live endpoints, real MFA replay/rate-limits, the live end-to-end Razorpay transition, and production-domain email loop].**

Muse Spark 1.3 must NOT be run in this pass (per directive).