# RELEASE CANDIDATE CHECKLIST

**Project:** CodeConClave Pro - `C:\Users\sride\CodeConClave-`
**Version:** Release Candidate 1 (RC1) - working tree snapshot as of 2026-08-17
**Stage:** 25 (FINAL PRODUCTION HARDENING + RELEASE CANDIDATE FREEZE)
**Verdict:** READY AS RELEASE CANDIDATE - NOT READY FOR PUBLIC PRODUCTION
(deployment not performed in this stage; production readiness blocked on external
credentials/config, see "Blocked" below)

---

## 1. Configuration & environment

| # | Check | Status | Evidence |
|---|---|---|---|
| 1.1 | All required env vars documented and validated by Zod at startup | PASS | `backend/src/config/env.ts` - 91 vars, `DATABASE_URL` required; startup fails fast on invalid shape |
| 1.2 | `.env.example` copy-verifiable (no empty required/typed values that break Zod) | PASS | `AI_PREMIUM_BUDGET_USD_PER_DAY` was empty (fails `z.coerce.number().positive()`); fixed to `=4` this stage |
| 1.3 | Production fail-fast guard: weak `SESSION_SECRET`/`JWT_SECRET`, `SESSION_COOKIE_SECURE != true`, `CSP_ENABLED != true` refuse to start | PASS | Verified 5/5 cases exit(1); guard at `env.ts` ~line 150 |
| 1.4 | Secrets never committed; `.env`/`.env.*` gitignored and untracked | PASS | `.gitignore` covers `.env*` (allow-lists `.env.example`); repo has zero commits - nothing tracked |
| 1.5 | Production config boots clean | PASS | `NODE_ENV=production`, strong secrets, secure cookies, CSP on: healthz 200 on :4300, 8/8 start/stop cycles, start 3.5-5.7s |
| 1.6 | Docker absent on host; runbook documents both process and container modes | PASS | `docs/DEPLOYMENT_GUIDE.md`, `docker-compose.yml` present; process mode verified |

## 2. Health, readiness, observability

| # | Check | Status | Evidence |
|---|---|---|---|
| 2.1 | `/healthz` liveness 200 | PASS | 15.6 ms p50 measured (Stage 24); 200 on live instance |
| 2.2 | `/ready` reflects DB readiness honestly | PASS | 503 while DB down, 200 when up; pooler-bound ~920 ms p50 |
| 2.3 | `/health` truthful rollup - no faking | PASS | api/database/cache/queue/worker HEALTHY; ai FAILED (providers down); storage NOT_CONFIGURED (memory adapter); plugins/sentry NOT_CONFIGURED; local-agent DEGRADED (hub up, no agent online) |
| 2.4 | Structured JSON logs, no secrets logged | PASS | `shared/logger.ts`; Redis URL redacted (`:***@`) |
| 2.5 | Error reporting: Sentry optional, honest when disabled | PASS | NOT_CONFIGURED when `SENTRY_DSN` missing; no fake delivery |

## 3. Process & shutdown

| # | Check | Status | Evidence |
|---|---|---|---|
| 3.1 | Graceful shutdown order: abort SSE streams -> close WS (agent + browser relay) -> stop watchdog -> server.close -> worker drain (10 s bound) -> pool.end -> exit(0); 15 s hard backstop | PASS (code) | `server.ts:83-98`; SSE registry added this stage (`abortActiveStreams`) |
| 3.2 | Signal delivery on Windows | BLOCKED | Windows cannot deliver SIGTERM/SIGINT handlers via `process.kill` (verified empirically, Node v26); graceful path targets Linux production |
| 3.3 | Worker drain bounded, no stuck claims | PASS | `DRAIN_TIMEOUT_MS = 10_000`; 35/35 claims, `dup_attempts=0`, `lost=0` (Stage 24) |
| 3.4 | Process stability | PASS | Stage 24 exits root-caused: tooling kill (12:27) + Supavisor `EMAXCONNSESSION` (07:20 UTC) - external, not app defect; 8/8 clean start/stop cycles; single-instance requirement documented |

## 4. External-call hardening (no wait-forever)

| # | Check | Status | Evidence |
|---|---|---|---|
| 4.1 | AI chain bounded 3 layers: per-attempt `AI_REQUEST_TIMEOUT_MS` + chain `AI_CHAIN_TIMEOUT_MS` + SSE deadline (+15 s) | PASS | `gateway.ts:384-385`, `providers.ts` all 4 providers, `routes.ts:283` |
| 4.2 | Embeddings bounded | PASS | `AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS)` in `embeddings.ts` and `memory/service.ts:433` |
| 4.3 | All other outbound fetches bounded (was 12+ bare fetches) | PASS | New `shared/http-timeout.ts` (`OUTBOUND_TIMEOUT_MS = 15_000`) applied to Google OAuth login, Google userinfo, Resend outbox delivery, Razorpay create/verify, plugin OAuth, GitHub adapter (3), Google adapter (6), Resend adapter (3) |
| 4.4 | Finite retries + bounded backoff everywhere | PASS | AI 3-attempt fallback; outbox capped backoff (max 60 min); plugin engine `withRetry` 2 attempts idempotent/1 non-idempotent + circuit breaker |
| 4.5 | Redis commands bounded | PASS | `commandTimeout: 10_000` added; `maxRetriesPerRequest: 2`; cache HEALTHY with real Upstash |
| 4.6 | DB statements bounded | PASS | `connectionTimeoutMillis 10_000` + `statement_timeout=30000` added (worst measured write ~5 s p50) |
| 4.7 | Outbound storage bounded | PASS | AWS SDK `NodeHttpHandler` defaults + SDK retries; storage not configured in this env (honest) |

## 5. SSE & WebSocket lifecycle

| # | Check | Status | Evidence |
|---|---|---|---|
| 5.1 | SSE client disconnect aborts generation and closes | PASS | `conversations/routes.ts:267-272`; tested `stream-hang-21` |
| 5.2 | SSE error path sends terminal `error` frame + `res.end()` | PASS | `routes.ts:313-326` |
| 5.3 | SSE deadline always closes the stream | PASS | `routes.ts:283` + chain abort |
| 5.4 | SSE server shutdown aborts active streams | PASS | `abortActiveStreams()` registry added this stage, called first in `shutdown()` |
| 5.5 | WS heartbeat kills dead sockets | PASS | 25 s interval, terminate missed round: `ws.ts:278-305`, `browser.ts:210-229` |
| 5.6 | WS in-flight requests bounded (10-60 s) | PASS | `ws.ts:254-261`, browser relay per-command timeouts; hello handshake 10 s |
| 5.7 | WS shutdown sends close frames 1001 | PASS | `ws.ts:219-227`, `browser.ts:51-60` from `server.ts:88-89` |

## 6. Security

| # | Check | Status | Evidence |
|---|---|---|---|
| 6.1 | Full security regression (Stage 22 suite + security suites) | PASS | See Stage 25 report section 8; 1028 backend tests pass |
| 6.2 | CSRF cookie + CSP enforced in production by fail-fast | PASS | `SESSION_COOKIE_SECURE`, `CSP_ENABLED` guards |
| 6.3 | Auth: sessions hashed, TTL, stale-session sweep on boot | PASS | `expireStaleSessions()` at `server.ts:57`; `AUTH_SESSION_TTL_DAYS` |
| 6.4 | Payments webhook HMAC + timingSafeEqual | PASS | `payments/routes.ts:134-136` |
| 6.5 | No debug artifacts in tree | PASS | 0 `.map` files in dist; 0 TODO/FIXME in backend src; 2 `console.log` (CLI usage + logger fallback) only |
| 6.6 | No secrets in repo | PASS | `.env` all values EMPTY; `.env.txt` (empty template copy) gitignored, untracked |

## 7. Data & operations

| # | Check | Status | Evidence |
|---|---|---|---|
| 7.1 | Migrations applied clean | PASS | 41/41 applied, 0 pending (spec text said 40/40; actual repo has 41 files) |
| 7.2 | Backup/restore documented honestly | PASS | `RUNBOOK.md` section 10: "No backups are configured in this environment" + pg_dump/pg_restore procedures |
| 7.3 | Rollback path | PASS | Prior release = git snapshot + `db:migrate down`; no migrations bundled in RC1 build (no migration files changed this stage) |
| 7.4 | Worker/watchdog in-process default; standalone worker documented | PASS | `npm start` vs `npm run worker` (`tsx src/workers/run.ts` - guide corrected this stage) |

## 8. Regressions (all automated suites, all green)

| Suite | Result | Evidence |
|---|---|---|
| Backend vitest | 1028 passed / 3 skipped (71 files) | 0 failures |
| Frontend vitest | 225/225 (38 files) | 0 failures |
| Local agent vitest | 49/49 (5 files) | 0 failures |
| Backend typecheck | PASS | `tsc -b` clean |
| Frontend typecheck | PASS | clean |
| Local agent typecheck | PASS | clean |
| Frontend production build | PASS | 433.46 kB JS (122.69 kB gzip) |
| Backend build | PASS | `tsc -p tsconfig.json` clean, no sourcemaps |

## 9. Performance smoke (Stage 24 final, unchanged in Stage 25)

| Metric | AFTER |
|---|---|
| task-create cc=5 p50 | 465 ms (was 8722 ms) |
| projects cc=20 p50 | 641 ms (was 2005 ms) |
| healthz cc=20 | 27.6 ms, 0 errors |
| queue integrity | dup_attempts=0, lost=0 |
| isolated task-create cc=1 p50 | 2571 ms (pooler-bound) |

## 10. Blocked / not verified in this environment (external dependencies)

| Area | Status | Why |
|---|---|---|
| Live AI success path | BLOCKED | All providers down (no credentials); `/ready` 503 honest; timeout/fallback paths covered by tests |
| Production object storage | BLOCKED | No R2/S3 config; memory adapter honest (NOT_CONFIGURED) |
| Live email delivery | BLOCKED | Resend not configured (domain unverified); outbox retries + timeouts in place |
| Live payments | BLOCKED | No genuine credentials; Razorpay Payment Link fallback available only; HMAC webhook verify implemented |
| Graceful signal shutdown (Windows) | BLOCKED | OS limitation; verified on Linux-compatible code path |
| Multi-instance scale-out | BLOCKED | Supavisor session pool_size=15 cap: max 10-client pool per instance, single instance enforced |

## 11. Release process steps (NOT performed - deployment is out of scope for Stage 25)

1. Tag RC1 snapshot (`git add -A && git commit && git tag rc1` - repository currently has zero commits).
2. Provision Linux host; install Node 22+; `npm ci`; `npm run build`; `npm run build:frontend`.
3. Configure all secrets via environment/secrets manager (never `.env` with values).
4. Run `db:migrate up` (41/41), verify `/healthz` + `/health` (only `api`/`database`/`cache`/`queue`/`worker` may be non-ok when providers are configured; `storage` must be HEALTHY with real bucket).
5. Deploy frontend static files + backend `node dist/server.js` behind TLS reverse proxy; enforce HTTPS (`SESSION_COOKIE_SECURE=true`).
6. Configure provider credentials + verify `/ready` 200 before declaring production-ready.
7. Set up nightly DB backups per `RUNBOOK.md` section 10 before public launch.
8. Smoke-test one chat, one task, one email, one payment flow.

---

**Conclusion:** RC1 is a clean, honest release candidate for a controlled deployment with
all external dependencies configured. It is NOT production-ready until items in section 10
(provider credentials, storage, email, backups, Linux host) are provisioned.
