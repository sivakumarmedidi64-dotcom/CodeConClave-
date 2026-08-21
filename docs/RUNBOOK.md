# CodeConClave Pro — Incident & Recovery Runbook (Phase 18)

Operational playbook. Sections that require a runtime that is not present in
this environment are marked and include the exact commands to run after
deployment.

## 0. Ground rules

- Never trust a single source of truth over the system's own evidence
  (`/health`, `/api/v1/operations/diagnostics`).
- No fake success: if a check cannot be performed, report BLOCKED/UNKNOWN.
- All state-changing recovery actions are idempotent where the system
  supports it (outbox, idempotency keys).

## 1. Health triage

```bash
curl -fsS https://app.example.com/healthz    # process alive?
curl -fsS https://app.example.com/ready      # 200 = ready, 503 = not ready
curl -fsS https://app.example.com/health     # full check list with labels
```

Interpret `/health`:
- `HEALTHY` — everything green.
- `DEGRADED` — at least one check DEGRADED or NOT_CONFIGURED (provider missing).
- `FAILED` — at least one check FAILED (e.g. database unreachable). `/ready`
  returns 503.

Operator diagnostics (owner/admin session):

```bash
curl -H "Cookie: cc_session=<session>" https://app.example.com/api/v1/operations/diagnostics
```

Includes DLQ depth, outbox backlog, metrics snapshot, and recent errors
(traceId only).

## 2. Database outage

Behavior: server fails fast at startup (`database unreachable`); at runtime
`/ready` → 503 and `/health` reports `database FAILED`.

Recovery:
1. Confirm Postgres is up: `docker compose ps` / provider dashboard.
2. Check `migrate:status`: `npm run db:migrate:status`.
3. Apply pending migrations: `npm run db:migrate` (server refuses to start
   with pending migrations by design).
4. Restart backend + worker; verify `/ready` → 200.

PostgreSQL runtime validation (when a live DB exists) — exact commands.
Validated against the Supabase pooler in Stage 25: 41/41 migrations
recorded, RLS enabled on 106 tenant-scoped tables, `row_security` effective:

```sql
-- all migrations applied?
SELECT file, applied_at FROM schema_migrations ORDER BY id;

-- RLS enabled on tenant-scoped tables?
SELECT relname, relrowsecurity FROM pg_class
WHERE relkind = 'r' AND relrowsecurity = true
  AND relname NOT LIKE 'pg_%' ORDER BY relname;

-- tenant isolation smoke (as application role)
SET LOCAL row_security = on;
SELECT count(*) FROM conversations WHERE user_id = 'another_user'; -- must be 0
```

## 3. Redis / queue outage

Behavior: with `QUEUE_PROVIDER=redis` unreachable, the cache falls back to the
in-memory store with a warning; queue operations fail visibly (no false
success).

Recovery:
1. `docker compose up -d redis` / provider dashboard.
2. Restart workers so they reconnect.
3. Verify DLQ and outbox depths via diagnostics (expected 0 under normal load).

Redis/queue runtime validation (when available):

```bash
redis-cli ping                                  # PONG
redis-cli LLEN codeconclave:queue               # pending queue depth
redis-cli LLEN codeconclave:dlq                 # dead-letter depth
npm run worker &                                # start worker
kill -TERM %1                                   # graceful drain + exit
npm run worker &                                # restart; tasks must resume
```

## 4. Worker restart / task recovery

- Graceful shutdown: send `SIGTERM`; the worker stops claiming and drains
  in-flight executions (bounded), then exits.
- Recovery is automatic: the orchestrator resumes a failed attempt from the
  last persisted checkpoint, reusing completed `coworker_runs` — never
  re-running them or regenerating the plan (`failure-17.test.ts`,
  `worker-16.test.ts`).
- If the worker is hard-killed, the watchdog re-claims and the sweep handles
  timeouts (see below).

## 5. Task timeout / DLQ

- Timed-out attempts are marked FAILED; the task moves to `RETRIED`/dead-letter
  as policy dictates. Dead-lettered rows land in `task_dlq`.
- Inspect: `GET /api/v1/operations/diagnostics` → `queue.dlqDepth`.
- Manual DLQ inspection (live DB):

```sql
SELECT id, task_id, reason, created_at FROM task_dlq ORDER BY created_at DESC LIMIT 20;
```

## 6. AI provider outage

Behavior: gateway degrades to the next qualified provider; a total outage
produces a real error to the client (never a fabricated success); planner
falls back to `DEFAULT_PLAN` with audit `source: 'default_fallback'`
(`failure-17.test.ts`, `ai-gateway-5.test.ts`).

Action: check `/health` → `ai` check; rotate the affected provider key and
re-test one real request (see PROVIDER_INTEGRATION_GUIDE.md).

## 7. Local agent offline / reconnect

Behavior: tasks stay `WAITING_FOR_LOCAL_AGENT` with nothing claimed while
offline; remote/terminal calls reject with `local_agent_offline`; the
WebSocket hub reconnects and actively replaces stale sockets
(`local-execution-17.test.ts`, `ws-16.test.ts`).

Action: verify the hub is attached (`/health` → `local-agent` check), restart
the local agent CLI, and confirm re-pairing.

## 8. Storage failure

Behavior: `storageCheck` reports NOT_CONFIGURED when no object storage is
configured; S3 failures surface as real errors (no fake success).

Live smoke test (after configuring `STORAGE_PROVIDER=s3`):

1. Upload a file (Files page / API).
2. Download it; compare checksum.
3. Delete it; verify it is gone.
4. Restore from Trash; verify content.
5. With `STORAGE_AT_REST_ENCRYPTION=true`, verify stored blob bytes are not
   plaintext.

## 9. Email failure

Behavior: outbox keeps failed sends PENDING with exponential backoff; only
after retries are exhausted does it become FAILED — never a false success
(`outbox-14.test.ts`). Resend enabled/disabled is explicit.

Action: verify `RESEND_API_KEY`/`RESEND_ENABLED`; check outbox backlog via
diagnostics; inspect provider dashboard for delivery status.

## 10. Backup / restore

**No backups are configured in this environment.** The following are the
procedures to put in place at deployment — do not claim backups exist until
they are configured and verified.

- **Database backup strategy**: nightly `pg_dump` (or the managed provider's
  continuous backups) with a tested retention window.
  ```bash
  pg_dump "$DATABASE_URL" -Fc -f "backup_$(date +%F).dump"
  ```
- **Restore procedure**:
  ```bash
  pg_restore --clean --if-exists -d "$DATABASE_URL" backup_YYYY-MM-DD.dump
  npm run db:migrate:status   # confirm schema matches app expectations
  ```
  Restore target must be RLS-compatible (roles/grants from `0015_rls.sql`).
- **File/storage recovery**: object storage is the source of truth for blob
  content; enable provider versioning + lifecycle rules before relying on it.
  `files` rows reference `storage_key`; re-upload from backups restores blobs.
- **Task recovery**: automatic (checkpoint resume); manual re-enqueue of
  dead-lettered rows is possible from `task_dlq` after review.
- **Audit retention**: no automated pruning exists. Manual retention (live DB):
  ```sql
  DELETE FROM audit_logs WHERE created_at < now() - interval '365 days';
  ```
  Decide the retention period for your compliance requirements before
  enabling any automated job.
- **Rollback procedure**:
  1. Backend/frontend: deploy the previous artifact (`dist/` is reproducible:
     `npm ci && npm run build` at the pinned commit).
  2. Database: `npm run db:migrate:down` reverts the last migration
     (migrations are ordered; down-runs are tested per migration).
  3. Verify `/ready` → 200 and run the acceptance gate suite.
- **Secret rotation procedure**:
  1. Generate new values (`openssl rand -hex 32`).
  2. Update the secret manager; restart backend + worker.
  3. Rotate provider secrets (AI/Resend/Google/GitHub/Razorpay) in their
     dashboards first, then update env.
  4. OAuth key rotation is covered by `security-17.test.ts` (old signatures
     rejected).

## 11. Rollout / verification after deploy

```bash
npm run db:migrate:status
curl -fsS https://app.example.com/healthz
curl -fsS https://app.example.com/ready
# run the full suite gate
npm test          # backend + frontend workspaces
npm run typecheck
```

## 12. Known non-automatable items

- Live provider transactions (AI/email/Google/GitHub/Razorpay).
- RLS isolation and constraint behavior on a real Postgres.
- Durable queue behavior with Redis.
- Browser-level E2E (no browser tooling in this environment).