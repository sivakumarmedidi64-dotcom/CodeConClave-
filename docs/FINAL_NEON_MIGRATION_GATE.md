# FINAL NEON MIGRATION GATE

Date: 2026-08-30
Provider: **Neon PostgreSQL** (replaced Supabase)
Railway project: `82dd1698-e7f6-4912-8cd6-299a1bc95557` (CodeConClave) · env `production` · service `backend`

---

## 1. Executive Result

| Gate | Result |
|------|--------|
| Neon connection gate | **PASS** |
| Migration runner (00/56 -> 56/56) | **PASS** |
| Schema / RLS / pgvector / pg_trgm | **PASS** |
| App-level DB read on Neon | **PASS** |
| Railway DATABASE_URL target | **NEON** |
| Supabase touched | **NO** |
| Deployment | **BLOCKED — awaiting explicit approval** |

All **56** migrations applied cleanly to the empty Neon database. Two additive,
surgical fixes were made to migration **0054** (reserved-word quoting) and
approved by the user before editing. No other migration was modified, skipped,
or reordered. No source code was changed.

---

## 2. Pre-migration state (verified before run)

- Schema was **EMPTY** (0 public tables); extensions `vector` / `pg_trgm` not yet present.
- PostgreSQL **18.6**, database `neondb`.
- Local `.env` repaired: `DATABASE_SSL=true` moved to its own line (was glued onto the URL); `DATABASE_URL` value preserved exactly.

## 3. Connection methodology

Railway's injected `DATABASE_URL` uses the **Neon pooled host** (`ep-…-pooler…`).
The app's pg Pool in `backend/src/shared/db.ts` sets `options: '-c statement_timeout=30000'`, which Neon's **pooled** endpoint rejects with `08P01 unsupported startup parameter in options: statement_timeout`.

The migration run therefore used the **Neon unpooled (direct) host** (derived from the connection by removing the `-pooler.` host suffix), where the startup parameter is accepted. Secrets were injected server-side via `railway run` and never printed. **No source files were modified** to run migrations.

## 4. Migration run log (summary)

| Sequence | Files | Result |
|----------|-------|--------|
| First run | 0001–0053 | ✅ applied (53) |
| First run | 0054 | ❌ failed (`syntax error at or near "column"`), rolled back |
| First run | 0055–0056 | ⛔ not attempted |
| Resume   | 0054, 0055, 0056 | ✅ applied (3) |
| **Total** | **All 56** | ✅ **56/56 applied** |

`schema_migrations` verified: count = **56**, first `0001_extensions.sql`, last `0056_stage26h_payment_link_binding.sql`, no missing numbers. Runner records SHA-256 per applied migration (transactional).

### 5. Migration 0054 fix (user-approved, surgical)

`database/migrations/0054_v4c_security_intelligence.sql` failed on PostgreSQL because two **reserved keywords** were used as unquoted column names inside `CREATE TABLE vulnerability_findings`:

- line 26: `column` → `"column"`  (`42601 syntax error at or near "column"`)
- line 35: `references` → `"references"`  (`42601 syntax error at or near "references"`)

Both were quoted (identifier preserved as `column` / `references`), so existing application code referencing `finding.column` (`backend/src/modules/security-intelligence/vulnerabilityManagement.ts:112`) continues to work unchanged. Full file re-validated in a rolled-back transaction (`0054_DRYRUN: PASS`) before committing.

> Note: this migration was incompatible with standard PostgreSQL; it had only ever been applied on Supabase. After this fix it is standard-PG compatible.

---

## 6. Post-migration verification (all PASS)

| Check | Value |
|-------|-------|
| Public tables | **167** |
| `schema_migrations` applied | **56 / 56** |
| pgvector installed | **0.8.6**, 1 `vector` column |
| pg_trgm installed | **1.6**, 1 trigram GIN index |
| HNSW index (`vector_cosine_ops`) | **1** |
| `app` schema | present |
| `app.uid()` function | present, returns `text` |
| `set_updated_at()` function | present |
| RLS enabled tables | **125** |
| RLS policies | **156** |
| Payment tables | **9** |
| App DB read (`feature_flags`) | **PASS** (12 rows) |
| RLS enforcement (no-context read on `users`) | returns **0 rows** (denied) → RLS live |
| `app.uid()` context eval | returns `probe-user-0000` when `app.current_user_id` set |

## 7. Railway target (verified)

- `DATABASE_URL` target: **NEON** (not Supabase)
- `DATABASE_SSL`: `true`
- Supabase: untouched throughout.

---

## 8. ⚠️ Pre-deployment caveat (separate from migration gate)

The **migration gate is PASS**, but the **running backend will not yet connect** to Neon
through the current configuration:

- `backend/src/shared/db.ts:23` sets `options: '-c statement_timeout=30000'`, sent as a startup parameter.
- Neon's **pooled** endpoint (the `-pooler` host in Railway's `DATABASE_URL`) rejects it: `08P01`.
- Therefore the app's runtime pool fails on the pooled host, exactly as the migration runner did before we routed it to the unpooled host.

Before deploying the backend, this must be resolved **in source** — the user's choice of
fix options. This was deliberately NOT modified here (no-source-change rule). Recommended
solutions (pick one, with approval):

1. **Unpooled connection** for the runtime pool (use the Neon direct host in `DATABASE_URL`), or
2. Remove `statement_timeout` from the startup `options` and instead set it per-session/query via `SET statement_timeout = '30s'` (correct Neon-pooled fix), or
3. Switch `db.ts` to `SET`-based timeout rather than the startup parameter.

Until one of these is applied, **do not deploy the backend** — deployment is BLOCKED pending
both this fix and explicit user approval.

---

## 9. Rules honored during this task

- ✅ No deployment performed.
- ✅ No Supabase object touched.
- ✅ No migration skipped or reordered; only 0054's two reserved-word identifiers quoted (user-approved).
- ✅ No migration run on a failing migration without stopping (stopped at 0054, reported, awaited approval).
- ✅ No source code modified for the run.
- ✅ No secrets printed (connection strings, passwords, API keys all redacted/never output).
- ✅ Cleanup of temporary probe scripts under `C:\Users\sride\AppData\Local\Temp\opencode\`.

## 10. Next steps (blocked on approval)

1. Resolve the runtime pool connection fix (#8) in `backend/src/shared/db.ts` with user approval.
2. Re-verify a full app-level DB round-trip on Neon.
3. Get explicit approval, then perform backend deployment.
