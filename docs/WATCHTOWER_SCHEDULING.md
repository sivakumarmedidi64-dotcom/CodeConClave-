# Watchtower Scheduling (CB1)

**Date:** 2026-09-05
**Audit reference:** `docs/CODECONCLAVE_FINAL_SYSTEM_AUDIT.md` — Critical Blocker 1 (payment watchtower not scheduled at runtime)

## What this fixes

`runPoolWatchtower` (backend/src/modules/payments/pool/watchtower.ts) was proven correct — read-only, globally unscoped, all C1–C7 checks, 7/7 unit tests, invariant I14 — but nothing invoked it at runtime. The watchtower is now runnable as a first-class scheduler job.

## The runner

`backend/src/scripts/run-watchtower.ts` (invoked via `npm run watchtower:run` from the backend, or `watchtower:run` from the repo root) runs the **existing** engine unchanged and agrees to a machine contract:

| stdout line | meaning |
|---|---|
| `WATCHTOWER_CHECKS=<n>` | number of checks executed (7 for C1–C7) |
| `WATCHTOWER_CLEAN=true\|false` | all checks OK |
| `WATCHTOWER_ALERT_DESTINATION_CONFIGURED=true\|false` | destination present (value never printed) |
| `WATCHTOWER_ALERT_SENT=true\|false` | alert actually dispatched |
| per-check lines `C1..C7 :: OK\|FAIL\|(STATE_UNREADABLE)` | full scan result |

Exit codes: **0** all checks OK · **1** any failing/unreadable check (scan still ran) · **2** operational failure.

A missing `PAYMENT_WATCHTOWER_ALERT_EMAIL` never skips or reduces the scan — the engine emits exactly one `ALERT_DESTINATION_UNCONFIGURED` warning and the exit code reflects the scan alone (verified by `run-watchtower.test.ts`, dead-DB subprocess: 7/7 checks, exit 1).

## Scheduling examples (pick one)

### Option A — cron / systemd timer (recommended, no extra infra)
Run every 5 minutes; page on non-zero exit:

```sh
*/5 * * * * cd /path/to/CodeConClave-/backend && npm run watchtower:run || alert-on-failure.sh
```

systemd unit `codeconclave-watchtower.service` (after build):

```ini
[Unit]
Description=CodeConClave payment watchtower
[Service]
Type=oneshot
WorkingDirectory=/path/to/CodeConClave-/backend
ExecStart=npm run watchtower:run
EnvironmentFile=/path/to/CodeConClave-/.env
```

### Option B — CI / scheduled workflow (GitHub Actions)
A schedule can also act as the monitor (ensure `npm ci` then `npm run watchtower:run` with `DATABASE_URL` from secrets). The repository contains a secret-scan workflow (`.github/workflows/secret-scan.yml`); whether it executes depends on the repo being connected to GitHub (local git is currently broken — see note below). Add a scheduled watchtower job here if the team prefers GitHub-hosted scheduling.

### Option C — in-process watchdog loop (self-hosted)
Wire `runWatchtowerCli()` into the existing watchdog sweep set with a periodic timer (~5 min, spread/locked), so a full app restart also (re)arms the monitor without external cron.

## Guardrails

- The runner adds **no checks** and **no logic**; it is an entry point + exit-code contract over the same read-only engine.
- It imports the engine directly (`../modules/payments/pool/watchtower.js`) and no mutating module — enforced by `run-watchtower.test.ts` (READ_ONLY_SURFACE).
- Alert destination values are **never** written to stdout/CI logs; only configured/sent booleans are.
- Note: the local git binary on this machine is broken, so history-related CI claims are documented as UNVERIFIED in the healing-round docs.