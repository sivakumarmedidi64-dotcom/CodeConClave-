# FINAL RELEASE CANDIDATE + KUBERNS DEMO SAFETY CHECK
**Date:** 2026-10-09 · **Service:** `https://codeconclave-api.onrender.com` · **Mode:** audit only — no deploy, no commit, no push, no env/infra change, no new feature.

> **Overall verdict: DEMO = GO · RELEASE CANDIDATE = NO-GO (conditional).**
> The Saturday demo runs on the build that is **already live** and was re-proven end to end in this pass. The *release* is not shippable as-is: the fix set is split across three different git states, the working tree cannot be committed safely as it stands, and one live production defect was found.

---

## A. Release identity and delta

Three distinct states exist. They are not the same code.

| State | Commit | Contents |
|---|---|---|
| **LIVE (production)** | `96b4241` | `feat(workbench): live development workbench` |
| **APPROVED SOURCE (HEAD, branch `temporary-demo-mode`)** | `9a4b33b` | `fix(execution): heartbeat the task during a long stage…` |
| **WORKING TREE** | HEAD + 19 modified (+836/−68) + 16 untracked | uncommitted |

**`96b4241 → 9a4b33b` = exactly 2 files, +42 lines:**
- `backend/src/modules/execution/orchestrator.ts` (+10) — `setInterval(touchTask(task.id), 10_000)` + `clearInterval` in `finally`
- `backend/src/foundation/orchestration-7.test.ts` (+32)

**The lease/attempt-fence repair is NOT in HEAD.** `attemptGeneration()`, `assertStillOwnsAttempt()`, `touchTask(taskId, attemptNumber)` fencing, the `attempt_superseded` conflict and the fence checks before stage groups/completion exist **only in the uncommitted working tree** (`orchestrator.ts` +71, `tasks.ts` +27, `routes.ts` +5, `approvals.ts` 6, `app.ts` 8).

Working-tree change set (19 files):

| Area | Files | Risk |
|---|---|---|
| Heartbeat + lease/attempt fence | `orchestrator.ts`, `tasks.ts`, `routes.ts`, `approvals.ts` | core execution |
| Agent route no longer behind `paid` | `app.ts` | auth/entitlement |
| Watchdog durable sweeps | `watchdog.ts` (+24) | **imports untracked files** |
| Local-agent policy | `local-agent/{index,policy}.ts` (+98) | local agent |
| Copy fixes | `LandingPage.tsx` (+35), `AutonomousTasksPanel.tsx` (+2) | demo copy |
| Boot/restoration | `frontend/server.cjs` (+80), `desktop/.../server.cjs` (+80), `spa-server.ts` (+49) | boot path |
| Tests only | `orchestration-7`, `state-machine`, `local-execution-17`, `workbench`, `LandingPage.test` | none |

**Deploy hazard:** `watchdog.ts` in the tree imports **untracked** `backend/src/shared/durable-{challenges,concurrency,counters,payment-tokens}.ts` plus untracked `database/migrations/0142_redis_to_postgres_state.sql`. Committing the tree without those 6 untracked source/migration files **breaks the build**. HEAD itself is clean of those imports.

**Verdict A: NO-GO for any release.** The candidate is not a single coherent commit.

---

## B. Heartbeat / lease / attempt-fence regression

- Backend heartbeat suites (7 files): **89/89 passed** — `orchestration-7`, `watchdog-recovery`, `task-engine`, `execution-true-completion`, `state-machine`, `terminal`, `execution-artifact-integrity`.
- Full backend suite (all 251 files): **4245 passed | 76 skipped | 0 failed**.
- `HEARTBEAT_TTL_MS = 30_000`, sweep every 15 s, `recoverStaleTasks()` in `backend/src/shared/queue.ts:…`.
- `last_heartbeat_at` writers: queue claim, `beginAttempt`, `touchTask` (post-stage only), `heartbeatRunningTasks()` — the last has **no production callers**. So on `96b4241` there is **no in-flight heartbeat refresh**; the 10 s interval added in `9a4b33b` is the missing refresher.
- `watchdog_checked_at` is a type-only field that is **never written** — it is not evidence of watchdog activity (earlier inference corrected).

**Verdict B: GO (tests).** Test coverage is green; the *runtime* gap is covered in K.

---

## C. Security / RLS

14 documented suites: **200 passed | 7 skipped (live-DB gated) | 0 failed.** Skips are honest environment-gated skips, not suppressed failures.

**Verdict C: GO.**

---

## D. Build and typecheck

| Target | Result |
|---|---|
| backend `tsc --noEmit` | **exit 0** |
| frontend `tsc --noEmit` | **exit 0** |
| desktop `tsc --noEmit` | **exit 0** |
| local-agent `tsc --noEmit` | **exit 0** |

**Verdict D: GO.**

---

## E. Test suites (remaining)

| Target | Result |
|---|---|
| frontend | **595/595** (89 files) |
| desktop | **73/73** (8 files) |
| local-agent | **54/54** (5 files) |
| backend | **4245 passed / 76 skipped / 0 failed** (251 files) |

**Verdict E: GO.**

---

## F. Exact demo rehearsal (runbook §4 prompt, step 10)

14/14 stages **PASS**, 0 fail, total 39.8 s:

`OPEN LANDING` → `REGISTER` (201, `cc_session`) → `ACCESS` (`temporaryDemoMode=true, paymentRequired=false, paidEntitlement=false, purchaseEnabled=false, reason=TEMPORARY_DEMO_MODE`) → `CREATE PROJECT` (201) → `CREATE TASK` (201, `CLOUD`) → **`TASK EXECUTION`: `CREATED > RUNNING > COMPLETED`, 33 s, `RESEARCH:PASS DOCS:PASS`, artifact `verification=PASS`, dlq=none, attempts=1** → `PLAN` (2 entries, structured) → `TIMELINE` (1 attempt / 5 steps / 2 runs) → `ARTIFACTS` (1) → `AUDIT` (6 real events) → `MEMORY` (honest empty) → `RELOAD` (same user) → `RE-ENTER` (no paywall) → `LOGOUT→LOGIN` (200+200).

Canonical prompt is now **4/4 COMPLETED** (274 s, 270 s, 86 s, 33 s) — was 3/3 in the gate report.

**Verdict F: GO.**

---

## G. Fixed-pipeline stage tally — **the gate report's number is wrong**

Recounted from all 9 `rehearse-step*.json` evidence files (14 stages each = 126):

| Slice | Result |
|---|---|
| **All stages** | **119 PASS / 7 FAIL = 126** |
| **Stages outside step 6** (what "109/109" meant to describe) | **117 / 117 PASS, 0 failures** |
| **Step 6 (task execution)** | **2 PASS / 7 FAIL** |

Breakdown of the 7 step-6 failures:
- **5 genuine product outcomes** (`steps 2–6`): task parked in `REQUIRES_REVIEW` because the plan contained `REVIEWER` and the reviewer is prompted *"Never rubber-stamp"*.
- **2 script-assertion artifacts** (`steps 7–8`): status was genuinely `COMPLETED`, but the rehearsal script still asserted `VERIFIED`. Assertion corrected in `steps 9–10`.

> **Correction to `SATURDAY_DEMO_GATE_REPORT.md:68`** — "**109 / 109** PASS across 9 runs, 0 failures" is arithmetically wrong. The true figure is **117 / 117** (stages 1–5, 7–14 across 9 runs). The *claim* (zero failures outside task execution) **holds**; the *number* does not. Line 150 and line 174 repeat the same wrong number.

**Verdict G: CONDITIONAL GO** — substance correct, published figure must be corrected to 117/117.

---

## H. Live bundle feature drift and stale UI claims

Deployed bundle: `/assets/index-CLxRt29f.js` — **same content-hashed filename as earlier today**, so the bundle has not changed since the last scan.

| Check | Live | Meaning |
|---|---|---|
| `PaymentGateModal` / `accounts.google` / `Sign in with Google` / `checkout` / `payment_required` / `pricing` / `card number` / `cvv` / `paywall` | **0** | payment + Google customer auth neutralised ✓ |
| `Google` / `google` / `stripe` (capitalised / icon / brand-colour hits) | present | plugin connector icons + palette only — benign |
| `razorpay` | 1 | payment-history receipt cell — read-only, benign |
| `upgrade` | 2 | a command-palette keyword + IndexedDB `onupgraded` — benign |
| `99.9` / `uptime` / `Coming soon` / `mock` / `hardcoded` | **0** | no false uptime/roadmap claims ✓ |
| Preview | explicit *"Preview tooling is not configured on this deployment"* (`data-testid="preview-honest"`) | honest ✓ |
| `Autonomous Cowork` / `24/7 Autonomous` heading | **0** | not in bundle at all |

**Two stale claims ARE live:**

1. **`Available now` ×15** on the landing feature grid, `Ready to use` ×0. The `LandingPage.tsx` rename (+35 lines) is **uncommitted**, so live still ships the old label — and the old grid also still shows `API access` and `Desktop environment` rows that the tree removed.
2. **`Nine perspectives run inside each 24/7 task…`** — `frontend/src/pages/CoworkersPage.tsx:45`. This one is **not fixed in any state** (live, HEAD or tree).

**Verdict H: CONDITIONAL GO** — the demo path (landing → project → task → workbench) does not *require* either string, but both are one navigation away and are false/overclaimed wording the master pass claimed as already corrected.

---

## I. Demo data legitimacy

No fabrication found.
- Audit trail returns **real rows** (16 events on the backup account; `task.created`, `project.created`, `dna.created`, `auth.login`, `auth.suspicious_login` — the last real, caused by repeated logins).
- Artifact content is **genuine markdown** (a real `csv2json` flag reference), sha256 `efab170a…`, 1872 bytes on the fresh run; `c27c5ade…`, 1687 bytes on the backup run.
- Memory returns an honest empty `{memories:[], total:0}` rather than a fake counter.
- Task/plan/steps/runs/artifacts all come from persisted DB rows, re-read on a fresh login.

**Verdict I: GO.**

---

## J. Cloud positioning wording

| Claim | Evidence | Status |
|---|---|---|
| CLOUD execution = READY | 4/4 canonical runs `COMPLETED` on live Postgres/Redis | **READY** ✓ |
| Hosting = always-on | Render **free** plan; `/health` returns `ok:false, status:"DEGRADED"` at top level; instance sleeps (cold start up to ~45 s) | **NOT always-on** ✓ — must not be claimed |
| LOCAL execution | UI exposes a `LOCAL` execution-mode `<option>` and the hint *"LOCAL mode waits for a paired Local Agent"*; `/health` → `local-agent: DEGRADED — no local agent currently online` | **NOT IMPLEMENTED** for demo ✓ — do not select `LOCAL` or `HYBRID` |
| Preview | `NOT_CONFIGURED` + explicit honest banner | **NOT CONFIGURED** ✓ |
| Kuberns | strategic/planned only — must stay in future tense | wording lives in `KUBERNS_DEMO_TALK_TRACK.md` |

**Verdict J: GO**, with two operating constraints: do not claim always-on hosting, and do not switch execution mode to `LOCAL`/`HYBRID` on stage.

---

## K. Live-production risk of the undeployed heartbeat fix

The fix in `9a4b33b` is **not deployed**. Live `96b4241` has no in-flight heartbeat refresh.

Evidence:
- Watchdog **is** running live: `/health` → `worker: HEALTHY` (from `lastWatchdogRunAt()`); `startWatchdog()` is called at `backend/src/server.ts:77`.
- **16 observed stages exceeded the 30 s TTL** across these rehearsals — including **34.8 s and 58.3 s inside successful canonical runs**, plus 305/321/324/783/809 s elsewhere.
- **Zero** `recovered_heartbeat_timeout` resets, and no illegal status transitions, across 16 task executions.

**Honest residual:** with no periodic refresher and a 15 s sweep against a 30 s TTL, a sweep should have matched an in-flight over-TTL stage. It did not, repeatedly, but **the mechanism that prevented a reset is not identified.** This cannot be reported as "probably fine" — it is unexplained-but-empirically-stable over 16 runs.

Operational mitigation (since no deploy is permitted): warm the instance before the demo, run **one task at a time**, retry **at most once**, use only the canonical prompt.

**Verdict K: CONDITIONAL GO** — acceptable risk for a single rehearsed demo; unacceptable as a permanent state.

---

## L. Deployment checklist (PREPARED, NOT EXECUTED)

**Pre-deploy verifications (must all pass before any deploy):**
1. Confirm target commit — **which one?** HEAD `9a4b33b` (heartbeat only) or the full worktree (heartbeat + lease fence + copy fixes)? This is the blocking decision.
2. If the worktree: first add the 6 untracked dependencies (`durable-challenges.ts`, `durable-concurrency.ts`, `durable-counters.ts`, `durable-payment-tokens.ts`, `0142_redis_to_postgres_state.sql`, plus `desktop/src/electron/spa-server.test.ts` / `agent-pairing.test.ts` / `boot-smoke.test.ts` / `postgres-durable-state*.test.ts`) or `watchdog.ts` will not compile.
3. Verify the migration `0142_redis_to_postgres_state.sql` is reversible and does not drop Redis state destructively.
4. Confirm `TEMPORARY_DEMO_MODE=true` and `VITE_DEMO_BUILD=1` remain in `render.yaml` (value keys, not secrets).
5. Confirm `healthCheckPath: /healthz`, `APP_URL`/`API_URL`/`CORS_ORIGINS` all equal `https://codeconclave-api.onrender.com`.
6. Re-run: backend tsc + full suite, frontend tsc + 595, desktop tsc + 73, local-agent tsc + 54.
7. Re-scan the built bundle for `PaymentGateModal`/`accounts.google`/`pricing`/`paywall` = 0.
8. Confirm `SESSION_COOKIE_SECURE`, `CSP_ENABLED`, `TRUST_PROXY=1`, `DATABASE_SSL=true`, `QUEUE_PROVIDER=redis` unchanged.
9. Confirm secrets (`SESSION_SECRET`, `JWT_SECRET`, `DATABASE_URL`, `REDIS_URL`, Razorpay, Resend) are `sync: false` / `generateValue: true` and are **not** re-generated by the deploy.
10. Schedule outside the demo window; have §M ready before starting.

**Rollback plan (prepared):** current live is `96b4241`. Roll back to `96b4241` — a known-good build with no destructive migration applied. Verify `/healthz` returns 200 and `/health` shows the 7 critical checks HEALTHY, then re-run the rehearsal script once to confirm `COMPLETED`.

**Verdict L: CONDITIONAL GO — checklist prepared, deliberately not executed.**

---

## M. Rollback plan

Target: **`96b4241`** (current live, proven).
- No destructive DB migration is involved in rolling back to it.
- Post-rollback verification: `/health` 7 critical HEALTHY → one full rehearsal (14/14) → bundle scan.

**Verdict M: GO (prepared).**

---

## N. No-surprises risk table (live, during the demo)

| Risk | R | Mitigation | Backup |
|---|---|---|---|
| Cold start (free plan sleeps) | H | Runbook §2 warm-up 10 min early; keep the tab open | Show already-warm health URL; expect up to ~45 s |
| Top-level `/health` shows `ok:false` / `DEGRADED` | M | **All 7 critical checks are HEALTHY**; the degraded ones are non-critical (`local-agent`, `plugins`, `sentry`) | Explain honestly; do not call it an outage |
| Provider quota / AI failure | M | AI check is HEALTHY now; canonical prompt uses only `web_search` + docs | Fall back to the backup account's already-completed task |
| Queue occupied by a stray task | M | Only one task at a time; queue check HEALTHY | Present the pre-completed backup task |
| Task parks in `REQUIRES_REVIEW` | H | Use **only** the §4 prompt (no `REVIEWER` in plan) | Present it as the gate working; retry once max |
| Artifact **download** returns 500 | H | See O below — list view works, do not click download | Show the artifact row + `verification=PASS` |
| Stale copy (`Available now`, `24/7 task`) | M | Do not linger on the landing grid; do not open `/coworkers` | Move on; the copy fix exists in the tree |
| SSE drop | L | REST polling fallback is the same path all timings came from | Poll |
| Session expiry | L | Re-login (2.2 s, proven) | Backup account |
| Watchdog reset of a healthy task | M | Undeployed fix — see K | Retry once, then show backup task |

**Verdict N: GO with the operating constraints above.**

---

## O. NEW DEFECT FOUND (not in any prior report)

**`GET /api/v1/artifacts/:id/download` and `/api/v1/artifacts/:id/references` both return `500 internal_error`.**

- Reproduced on a **fresh artifact created by today's rehearsal** (`art_t13xo1m2hvg45zrelvju`) *and* on the backup account's artifact → not data-specific.
- `GET /api/v1/artifacts?taskId=…` returns **200** with full content inline, so listing/verification is unaffected.
- Present identically in **live `96b4241`, HEAD `9a4b33b`, and the working tree** — `git diff 96b4241 HEAD -- backend/src/modules/artifacts/` is empty and the tree has no changes there. It is pre-existing, not introduced by this work.
- **Root cause:** `assertArtifactAccess()` (`backend/src/modules/artifacts/service.ts:227-241`) passes params `[artifactId, userId]` but the SQL binds only `$1`, because `ARTIFACT_TENANT` hardcodes `$1`:
  ```sql
  WHERE a.id = $1 AND (p.owner_id = $1 OR p.id IN (SELECT project_id FROM project_members WHERE user_id = $1))
  ```
  PostgreSQL's extended protocol rejects a bind that supplies 2 values for a 1-parameter statement → driver throws → unhandled → 500. Both failing endpoints call `assertArtifactAccess` first, which is why they fail identically while `listArtifacts` (which uses `$1` **and** `$2`) succeeds.
- **Why tests missed it:** `backend/src/foundation/artifacts-8.test.ts` uses a mocked `db.state.resolve = (text, params) => …` that never validates parameter counts, so all 4245 backend tests pass against a mock that production Postgres would reject.
- **UI impact:** `WorkPage.tsx:221` (`download`) shows a toast *"download failed"* — no crash; `WorkbenchPanels.tsx:268` is an `<a href>` that would land on the JSON 500.
- **Demo impact:** **not on the approved path** — the runbook only *lists* artifacts (step 9, backup §5 step 6), both of which work.

**Fix is a one-line param-order change** (`WHERE a.id = $2` with params `[userId, artifactId]`, or make `ARTIFACT_TENANT` parameter-index-aware), plus a regression test that asserts parameter counts.

**Not applied** — out of scope for an audit-only pass; see decision request below.

---

## Summary verdicts

| | Verdict |
|---|---|
| A Release delta | **NO-GO** — three-state drift, not one coherent candidate |
| B Heartbeat/lease tests | **GO** |
| C Security/RLS | **GO** |
| D Build/typecheck | **GO** |
| E Test suites | **GO** |
| F Exact rehearsal | **GO** (14/14, canonical prompt now 4/4) |
| G Stage tally | **CONDITIONAL GO** — 109/109 must be corrected to **117/117** |
| H Bundle / stale claims | **CONDITIONAL GO** — `Available now`×15 and `24/7 task` still live |
| I Demo data legitimacy | **GO** |
| J Cloud positioning | **GO** (+ two operating constraints) |
| K Undeployed heartbeat fix | **CONDITIONAL GO** — stable over 16 runs, mechanism unexplained |
| L Deployment checklist | **CONDITIONAL GO** — prepared, not executed |
| M Rollback | **GO** (prepared) |
| N No-surprises risks | **GO** (+ operating constraints) |
| **Saturday demo (on the live build)** | **GO** |
| **Release / deploy** | **NO-GO** |

**No deploy, no commit, no push was performed. No production, env, or infra value was changed.**
