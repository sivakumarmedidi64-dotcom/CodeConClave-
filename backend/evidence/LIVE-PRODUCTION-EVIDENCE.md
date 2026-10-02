# LIVE PRODUCTION EVIDENCE — CodeConClave (2026-09-28)

Production target: Railway — `https://wholesome-generosity-production-f81f.up.railway.app`.
Verified directly against the real production Postgres (Neon, `-pooler` stripped)
via `tsx dist/cli.mjs backend/src/database/migrate.ts up` and read-only SQL probes.

## Environment (verified, names only for secrets)

| variable | value |
| --- | --- |
| `TRUST_PROXY` | `1` (was the invalid bare `true`; fixed via `railway variables --set`) |
| `UNLOCK_MODE` | `AUTOPILOT` |
| `RAZORPAY_MODE` | `payment_link` |
| `RAZORPAY_WEBHOOK_ENABLED` | `true` |
| `CSP_ENABLED` / `SESSION_COOKIE_SECURE` | `true` / `true` |
| `INTERNAL_WEBHOOK_TOKEN` | present in Railway AND as Cloudflare worker secret |
| `REDIS_URL` | ABSENT |
| `QUEUE_PROVIDER` | `memory` (invalid for production — boot guard refuses) |

## Migration ledger (production)

`schema_migrations` rows `>= 0130` (name + sha256 prefix), verified live:

```
0130_payment_reconciliation.sql           sha256:2ef98b1f0f14
0131_free_fallback_normalization.sql      sha256:933572972793
0132_provider_check_hygiene.sql           sha256:deeee5185355
0133_auth_identity_and_founder.sql        sha256:c01345faef9b
0134_task_checkpoint_manifests.sql        sha256:9559aec0471f
0135_superpowers_chain_convergence.sql    sha256:3e97b0edbb89
0136_ai_agent_runs_updated_at.sql         sha256:c61068cb603a
```

0134/0135/0136 were applied to production in this pass. 0135 closed the
`0079..0112` divergence: 162 tables the ledger claimed but production never had.

## Schema state (production)

- `PUBLIC_TABLES = 367` (excludes `schema_migrations`; includes Neon scratch
  `playing_with_neon`).
- Superpowers tables present as real relations:
  `task_checkpoint_manifests`, `proof_claims`, `fusion_scores`, `echo_lessons`,
  `warden_policies`, `spec_entries`.
- Post-convergence diff vs verify: `MISSING 0 / EXTRA 1 (playing_with_neon)`.

## ai_agent_runs.updated_at (production)

- Column `updated_at` present, trigger `trg_ai_agent_runs_updated_at` present.
- The exact code UPDATE path was sanity-tested against production inside a
  `ROLLBACK` transaction: `RUN_UPDATE_OK` (row updated, timestamp changed), then
  rolled back — zero persisted impact. `0136_ai_agent_runs_updated_at.sql`.

## Webhook rail (now fail-closed, defense-in-depth)

Razorpay -> Cloudflare worker `codeconclave-razorpay-webhook-adapter`
(`/razorpay/webhook`) -> HMAC verify -> forward with `Authorization: Bearer
<INTERNAL_WEBHOOK_TOKEN>` -> backend `/api/v1/payments/webhook/razorpay` ->
token gate (when configured) -> HMAC verify -> idempotent reconciliation.

- Backend token gate implemented (`backend/src/modules/payments/routes.ts`) and
  fail-closed in production config (`backend/src/config/env.ts`: webhook enabled
  + missing token = refuse to boot).
- Worker deployed version `a1efb59e-b44c-45db-80d3-751679e7a23f` (Account
  `48c1eb075b406741091b29a9c7806571`, logged in as
  `sivakumarmedidi64@gmail.com`). Worker secrets present:
  `CODECONCLAVE_BACKEND_URL`, `RAZORPAY_WEBHOOK_SECRET`,
  `RAZORPAY_WEBHOOK_SECRET_LEGACY`, `INTERNAL_WEBHOOK_TOKEN`.

## Not yet verified (real blocker / next steps)

- Production deploy: BLOCKED. `REDIS_URL` absent + `QUEUE_PROVIDER=memory`;
  the production boot guard refuses to start (per-process state unacceptable
  for MFA challenges / distributed rate limits / idempotency). Redis
  provisioning is blocked by an expired Railway trial:
  `Failed to add Redis: Your trial has expired. Please select a plan to
  continue using Railway.`
- Live end-to-end webhook / payment activation, Razorpay dashboard delivery,
  and Resend email delivery: not performed — no fabricated evidence.

### Status: BLOCKED — EXTERNAL INFRASTRUCTURE REQUIRED

Upgrade the Railway plan (billing, user action), then:
`railway add --database redis --service redis`, set `REDIS_URL` +
`QUEUE_PROVIDER=redis`, redeploy (`railway up`), and verify
`/`, `/healthz`, `/health`, `/ready`, `/login`, `/register`, `/pricing`.