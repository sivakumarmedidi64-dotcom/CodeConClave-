# CodeConClave Pro — Known Limitations (Phase 18)

Honest list of what is not yet proven or not yet implemented. Nothing here is
hidden; each item has a documented mitigation or a runbook procedure.

## Runtime validation blockers (environment)

| # | Limitation | Status | Mitigation / next action |
| --- | --- | --- | --- |
| 1 | Live PostgreSQL (Supabase pooler) is now used and validated: 41/41 migrations applied, RLS active on all 106 tenant-scoped tables, index-backed query plans verified (Stage 24–25). Remaining: tenant-isolation smoke as a dedicated non-superuser app role (pooler connects as `postgres`), and latency is pooler-geography-bound (Singapore) vs a local Postgres. | RESOLVED (partially) | App-role smoke at deploy; local Postgres reference numbers in `perf-17.test.ts`. |
| 2 | Redis (Upstash) reachable as of Stage 25 (health `cache` + `queue` HEALTHY); verified via health endpoint and queue claims. Durable queue/DLQ retry behavior against real Redis still warrants a load run (Stage 24 ran on memory-fallback for the queue phase). | PARTIAL | Load run with `QUEUE_PROVIDER=redis` + DLQ verification. |
| 3 | No live AI provider credentials — routing, streaming, fallback, usage/cost metadata, tool-call normalization unproven against real APIs. | BLOCKED | Contract suites pass (`ai-gateway-5.test.ts`); one real request per provider at deploy. |
| 4 | No live Resend — real email delivery, outbox/retry/idempotency against the provider unproven. | BLOCKED | Contract suites pass (`outbox-14.test.ts`). |
| 5 | No live Google credentials — OAuth consent + Gmail/Drive/Sheets/Calendar calls unproven. | BLOCKED | `security-17.test.ts` covers the OAuth state machine. |
| 6 | No live GitHub credentials — App auth + permitted operations unproven; webhooks deferred. | BLOCKED | `.env.example` documents deferred webhook. |
| 7 | Razorpay — Payment Link ON; API/webhook modes OFF (no real credentials). No verified live transaction. | BLOCKED | `docs/PAYMENT_CAPABILITY.md`. |
| 8 | Object storage — R2 deferred (`R2_NOT_CONFIGURED`); no live S3/R2 write/read/delete/restore. | BLOCKED | `STORAGE_PROVIDER=s3` + smoke test at deploy. |
| 9 | Cloudflare Worker/KV and Sentry not validated (no token/DSN). | BLOCKED | Env-gated; enable when credentials exist. |
| 10 | Browser-level E2E not possible (no browser automation tooling); frontend verified via React Testing Library journeys. | BLOCKED | RTL journeys cover the critical flows. |

## Implementation-level limitations

| # | Limitation | Severity | Notes |
| --- | --- | --- | --- |
| 11 | Audit log has no automated retention/pruning. | Low | Manual `DELETE` documented in runbook; add a scheduled sweep in a future phase. |
| 12 | In-memory cache/queue when `REDIS_URL` unset or unreachable — not durable across restarts. | Low (dev only) | Documented; production must set `REDIS_URL` + `QUEUE_PROVIDER=redis`. |
| 13 | `STORAGE_PROVIDER=memory` is local disk, single-instance only. | Low (dev only) | Production requires `s3`/`r2`. |
| 14 | Session-expiry and digest sweeps run inside the long-lived server process; a multi-replica deployment must avoid double-execution. | Low | Sweeps are idempotent per period/session; schedule guards documented in code. |
| 15 | Frontend has no runtime env vars (same-origin `/api/v1`) — requires frontend and API on the same origin or a correct `CORS_ORIGINS` allow-list. | Low | Deployment guide documents the topology. |
| 16 | One timing-sensitive frontend test flaked once under artificial CPU contention during a full-suite parallel run; green in isolation and on full re-runs. | Low | Not a test weakening; re-run to confirm. |
| 17 | GitHub webhooks intentionally not implemented (no production endpoint yet). | Low | Deferred by design. |
| 18 | Performance targets verified on the emulated (mocked) database layer; live latency numbers require a production run. | Medium | `perf-17.test.ts` records honest TARGET/MEASURED on emulated stack. |

## What is deliberately NOT claimed

- The product is not claimed production-ready without the runtime validations
  above (acceptance matrix marks runtime BLOCKED, not PASS).
- No verified payment, email delivery, or AI transaction is claimed.
- R2 is not claimed active. Sentry is not claimed active. Cloudflare worker is
  not claimed validated.