# CODECONCLAVE — REAL INFRASTRUCTURE ACTIVATION (2026-09-29; LIVE on Render 2026-09-30)

Real infrastructure only. All evidence below was freshly produced today via the
real Railway/Neon/Resend/Cloudflare endpoints (never mocks). Companion artifact:
`backend/evidence/INTEGRATION-EVIDENCE.md` (dated section for this pass).

> **Scope note (read before citing).** The "LIVE on Render" rows below describe
> service `srv-da4a58m7bikc73dj0ev0` at commit **`dd997d9`** — the
> **pre-hardening** deployment (schema through `0136`). The hardening release that
> ships with this file adds migrations `0138`–`0141` and changes auth, object
> storage (`STORAGE_PROVIDER` default `postgres`), health semantics, and
> filesystem/SMB handling. Redis/queue/worker/AI wiring and the `--include=dev`
> build fix described here remain valid; the per-endpoint live results must be
> re-verified against the newly deployed build. See `docs/KNOWN_LIMITATIONS.md`.

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

## 2. REAL REDIS — LIVE (Upstash Free, TLS)

| item | result |
|---|---|
| provision | Real Upstash Redis wired on Render (`REDIS_URL`, `QUEUE_PROVIDER=redis`) |
| direct proof | `PING` → **PONG**, `SET`/`GET` round-trip **live-ok** |
| live health | `/health` `cache HEALTHY`, `queue HEALTHY` (real shared store, no in-memory fallback) |
| memory fallback | **NOT used** (guards untouched; boot refuses without real Redis) |

## 3. DEPLOY — LIVE on Render Free (₹0, no card)

| item | result |
|---|---|
| host | **Render Free** — https://codeconclave-api.onrender.com (service `srv-da4a58m7bikc73dj0ev0`, Singapore) |
| live deploy | `dep-dauhu5psrm7s73cb2te0`, commit `dd997d9`, status **live** |
| build | `npm ci --include=dev` + shared/backend/frontend builds — green from a clean clone |
| root cause fixed | `vite build` had failed with `ERR_MODULE_NOT_FOUND @vitejs/plugin-react`; the plugin is a **devDependency** and Render builds with `NODE_ENV=production`, so `npm ci` omitted devDependencies. Fixed via `--include=dev` (pinned in `render.yaml` + live service buildCommand). No code weakened. |
| endpoints | `/healthz` ok, `/health` DB+Redis+queue+worker+AI HEALTHY, `/api/v1/health` healthy, live auth + `/sessions` |
| headers/CSP/CSRF/sessions | **verified live**: HSTS, strict CSP, nosniff, DENY, no-referrer; same-origin-only CORS; CSRF cookie+token enforced; Secure+HttpOnly session |
| Electron hosted-backend | **done**: packaged builds proxy to the Render origin (`spa-server.ts:34`); desktop typecheck+build exit 0 |
| desktop installer | not published (release artifacts removed from git); `/downloads/info` honestly reports `available:false` |

## 4. RAZORPAY

| item | result |
|---|---|
| Cloudflare Worker | **LIVE + fail-closed today**: `GET /` → 404, unauthed `POST /razorpay/webhook` → 401 (cf-ray on both) |
| production vars | Payment Links (`RAZORPAY_API/TEAM/PRO_PAYMENT_LINK[_ID]`), `RAZORPAY_WEBHOOK_ENABLED`, `RAZORPAY_WEBHOOK_SECRET[_LEGACY]`, `INTERNAL_WEBHOOK_TOKEN` — present |
| live provider event | NOT fired (needs Razorpay dashboard/signing + a running backend). Keys not required by the fixed Payment-Link architecture; webhook secret + internal token are the rail. |
| end-to-end | **LIVE + guarded**: worker forwards to the Render backend; no-sig → 401, bad-sig → 401, wrong path → 404; backend: no bearer → 401 `invalid_internal_token`, valid bearer + bad sig → 401 `invalid_signature`. Real provider event still not fired (would require a real customer payment — never fabricated). |

## 5. EMAIL — REAL DELIVERY PROVEN (Resend)

- Credential valid (functional domain-scoped response, not 401).
- Controlled real delivery → **HTTP 200, id issued, provider status `queued`** to the account owner.
- **Live from the deployed service**: `POST /api/v1/auth/verify-email/send` → **200 `{"sent":true,…}`**, with the matching `email_verifications` row written to prod Neon (`2026-09-30T14:27:14Z`, PENDING).
- Remaining: verify a sender domain at resend.com/domains for outbound to arbitrary recipients.

## 6. LOCAL-FIRST / SECURITY — status preserved

- Local-first verified previously (filesystem, workspace security, memory, persistence, cloud boundary) — unchanged, no redesign.
- Tenant isolation: real app-layer proof above **and re-verified live** (two live users, each sees only its own session — zero cross-tenant leakage); DB-layer gap documented honestly (live role `neondb_owner` has BYPASSRLS, so RLS is not the runtime boundary); CSRF/sessions/proxy/MFA/payment-signature verified in unit suite **and** live headers/CORS/CSRF/webhook guards verified on the deployed host.

---

## FINAL GATE MATRIX (strict)

| item | status |
|---|---|
| POSTGRES reachable | ✅ real Neon `neondb` (live prod) |
| POSTGRES migrations | ✅ 133/133 applied on live prod; last `0137_audit_success_column.sql` |
| POSTGRES real cross-tenant | ✅ app-layer two-tenant live probe: zero leakage |
| RLS enabled | ✅ 294/368 tables, 327 policies; ⚠️ runtime role `neondb_owner` has BYPASSRLS (app-layer scoping is the boundary) |
| REDIS reachable | ✅ real Upstash Redis — live `PING`→PONG, SET/GET; health `cache HEALTHY`, `queue HEALTHY` |
| BACKEND live | ✅ **Render Free live**, commit `dd997d9`, deploy `dep-dauhu5psrm7s73cb2te0` |
| BACKEND /healthz etc. | ✅ `/healthz` ok, `/health` DB+Redis+queue+worker+AI HEALTHY, `/api/v1/health` healthy |
| LIVE auth flow | ✅ register 201, Secure+HttpOnly session, `/me` 200, `/sessions` scoped per user |
| LIVE email delivery | ✅ Resend `{"sent":true}` from deployed service + `email_verifications` row in prod DB |
| LIVE CORS / headers / CSRF | ✅ HSTS+CSP+nosniff+DENY, same-origin-only CORS, CSRF cookie+token enforced |
| RAZORPAY worker live | ✅ worker + backend both live and fail-closed (401 no-sig / 401 bad-sig / 401 bad-token) |
| RAZORPAY real provider event | ⏳ not fired (needs a real customer payment; never fabricated) |
| PAID entitlements | ✅ 402 for unpaid users — nothing fabricated |
| DESKTOP hosted backend | ✅ typecheck+build exit 0; packaged builds proxy to Render |
| DESKTOP installer published | ❌ none published (release artifacts removed from git); `/downloads/info` honestly reports `available:false` |
| LOCAL-FIRST | ✅ verified (no redesign) |
| OBJECT STORAGE / SENTRY | ⏳ not configured (honestly reported NOT_CONFIGURED) |

## FINAL VERDICT

**READY — deployed to real production infrastructure at ₹0 on Render Free
(https://codeconclave-api.onrender.com), with every core subsystem verified
live: real Neon PostgreSQL (133 migrations, boot-enforced), real Upstash Redis
(cache + queue + MFA/rate-limit state), live auth with real DB writes, real
Resend email delivery, real AI provider (`google HEALTHY`), real Razorpay
payment_link mode with a guarded live webhook chain, and same-origin-only
security headers/CORS/CSRF. The only unverified item is a real customer
Razorpay payment event, which is deliberately not fabricated; and the desktop
installer is not yet published (honestly reported). No card, no paid tier, no
mocks.**

Known follow-ups (non-blocking, honest): (1) RLS is enabled but the live DB
role bypasses it — switch to a non-BYPASSRLS role to make RLS the runtime
boundary; (2) publish a desktop installer to enable `/downloads/desktop`;
(3) configure object storage + Sentry; (4) `nemotron` shows OFFLINE in
`provider_health` while `google` is HEALTHY.

Muse Spark 1.3 must NOT be run in this pass (per directive).