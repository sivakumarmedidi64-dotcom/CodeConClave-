# FINAL NEON RUNTIME CONNECTION GATE

Date: 2026-08-30
Provider: **Neon PostgreSQL** (replaced Supabase)
File changed: `backend/src/shared/db.ts` (only file)
Railway: project `82dd1698-e7f6-4912-8cd6-299a1bc95557` · env `production` · service `backend`

---

## 1. Result

| Item | Result |
|------|--------|
| Runtime strategy | **UNPOOLED_NEON** |
| db.ts fix | **APPLIED** |
| Typecheck | **PASS** |
| Build (shared + backend) | **PASS** |
| Backend DB initialization | **PASS** |
| AUTH | **PASS** |
| DB_QUERY | **PASS** |
| RLS | **PASS** |
| Migrations | **56/56** |
| Payments | **PASS** |
| Secrets | **CLEAN** |
| Deployment | **BLOCKED — awaiting explicit approval** |

## 2. Blocker resolved

The runtime backend failed to connect because Neon's **pooled** endpoint
(`ep-…-pooler…`) rejects arbitrary startup parameters. `backend/src/shared/db.ts:23`
sets `options: '-c statement_timeout=30000'` (a startup parameter), which Neon's pooled
endpoint rejected with `08P01 unsupported startup parameter in options: statement_timeout`
— the same blocker that stalled the migration run.

## 3. Chosen strategy: UNPOOLED_NEON

- This app is a **persistent Node process** running its own in-process `pg.Pool`
  (`max: 10`). It does **not** require Neon's pooled (transaction/session) endpoint,
  which is intended for many short-lived/serverless connections.
- The migration gate already proved the Neon **direct/unpooled** host accepts the
  existing `statement_timeout` startup parameter.
- Only ONE change was made (not both). The `SET statement_timeout` alternative was NOT
  applied.

## 4. The minimal fix (backend/src/shared/db.ts)

Added a small `resolveConnectionString()` helper used when constructing the pool:

- Reads the env-supplied `DATABASE_URL` (still the single source of truth — **no
  hostname, password, or any secret hardcoded**).
- If the host uses the Neon pooled suffix (`-pooler.`), it derives the **direct/unpooled**
  host by stripping that suffix.
- Preserves the query string (sslmode, channel_binding) and credentials.
- Leaves non-Neon / non-`-pooler` URLs untouched.
- `DATABASE_SSL=true` handling is unchanged (`ssl: { rejectUnauthorized: false }`).
- The `statement_timeout=30000` startup parameter is retained (valid on the unpooled host).

```ts
function resolveConnectionString(url: string): string {
  try {
    const u = new URL(url);
    if (/-pooler\./.test(u.hostname)) {
      u.hostname = u.hostname.replace('-pooler.', '.');
      return u.toString();
    }
  } catch {
    /* non-URL connection string: leave untouched */
  }
  return url;
}
```

## 5. Local validation (all PASS)

| Check | Result |
|-------|--------|
| `npm run typecheck --workspace @codeconclave/backend` | **PASS** |
| `npm run build --workspace @codeconclave/shared` then backend | **PASS** |
| `npm test --workspace @codeconclave/backend` | **98 files, 1775 passed, 3 skipped** (skips = DB-live tests that skip without a local test DB; tests ran against fake `localhost` URL so the real Neon DB was never touched by tests) |

## 6. Runtime DB test via the application init path

Run under `railway run -s backend -e production` using the **actual built
`dist/shared/db.js`** pool — the exact init path `server.ts` uses (`pool → ping()`).

| Check | Result |
|-------|--------|
| Pool loads (no crash) | **PASS** |
| Railway target | **NEON** |
| `DATABASE_SSL` | `true` |
| `db.ping()` (server startup gate) | **PASS** |
| `SELECT 1` through app pool (startup param accepted, no 08P01) | **PASS** |
| `SELECT count(*) FROM schema_migrations` | **56** |

No crash-loop / no connection-parameter rejection.

## 7. RLS / database integrity (unchanged)

| Check | Result |
|-------|--------|
| Migrations recorded | **56/56** |
| RLS-enabled tables | **125** |
| RLS policies | **156** |
| `app.uid()` function | present (1) |
| pgvector | 0.8.6 |
| pg_trgm | 1.6 |
| Public tables | 167 |

No schema/RLS/pgvector/payment changes were made for this fix.

## 8. Payments preservation

Source of truth `backend/src/modules/payments/service.ts` (unchanged):

| Plan | Amount (INR) | Payment link |
|------|--------------|--------------|
| PRO | **₹999** | `https://rzp.io/rzp/sAgHIpxS` |
| TEAM | **₹4999** | `https://rzp.io/rzp/3ioXlCxd` |

Payment architecture/tests assert these exact values and no PRO/TEAM fallback. No real
payment was made.

## 9. Secret safety

- `DATABASE_URL` value, passwords, API keys, tokens, session/JWT secrets: **never printed**.
- Sanitized scan of the changed file (`backend/src/shared/db.ts`) and the earlier migration edit: **CLEAN** (no credentials).
- Temp probe scripts cleaned up from `C:\Users\sride\AppData\Local\Temp\opencode\`.

## 10. Railway status (no deploy performed)

- Railway `DATABASE_URL` = **NEON** (unpooled-host derivation active at runtime).
- `DATABASE_SSL=true`.
- Runtime connection configuration **compatible** (proven by §6).
- **No deployment executed.**

## 11. Rules honored

- ✅ Only ONE strategy chosen (UNPOOLED_NEON).
- ✅ Only `backend/src/shared/db.ts` changed for the runtime fix.
- ✅ No database recreation, no new DB, no Supabase, no Railway PG/Redis, no GitHub/Vercel/Render.
- ✅ No RLS/pgvector/payment changes.
- ✅ No migrations re-run (not needed — no schema change).
- ✅ No real payment.
- ✅ No secrets exposed.
- ✅ Deployment left **BLOCKED**.

## 12. NEXT STEP

Request **explicit approval for Railway backend deployment**.
