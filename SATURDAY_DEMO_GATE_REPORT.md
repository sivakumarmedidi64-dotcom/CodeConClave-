# SATURDAY 2:00 PM DEMO LOCK — GATE REPORT

Pass type: **read-only demo-lock**. Target: the one live production environment.
Hard rules honoured: **no deploy, no commit, no push, no production infra/secret change, no new product feature, no fabricated local/preview/Kuberns surface, no false 24/7 claim.**
Evidence: 9 full live rehearsals + 6 supplementary live experiments against `https://codeconclave-api.onrender.com` on 2026-10-08.

---

## §22 — DEMO-GATE CHECKLIST

| # | Gate item | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Canonical demo path defined and scripted | **PASS** | Runbook §4–§5; prompt is 3-for-3 to `COMPLETED` |
| 2 | `SATURDAY_DEMO_RUNBOOK.md` written | **PASS** | Delivered |
| 3 | `KUBERNS_DEMO_TALK_TRACK.md` written | **PASS** | Delivered |
| 4 | Payment neutralized for the demo, code intact | **PASS** | `TEMPORARY_DEMO_MODE=true` + `render.yaml` value; deployed bundle has 0 hits for `PaymentGateModal`, `checkout`, `Upgrade`, `402`, `payment_required` |
| 5 | Google OAuth removed from demo/public surface | **PASS** | Deployed bundle: 0 hits for `Google`, `Sign in with Google`, `accounts.google`; server-side `/google/callback` remains plugin-only |
| 6 | Demo-mode entitlement contract verified live | **PASS** | `GET /access` → `temporaryDemoMode=true, paymentRequired=false, paidEntitlement=false, purchaseEnabled=false, reason=TEMPORARY_DEMO_MODE` in all 9 runs |
| 7 | No 402 / paywall on project or task creation | **PASS** | 9/9 project and task creations returned 201 |
| 8 | Panel loading / empty / error states | **PASS** | Memory returns an honest `{memories:[],total:0}` empty envelope; artifacts `count=0` when the gate declined; audit returns real event rows |
| 9 | Canonical path reaches `COMPLETED` with a persisted artifact | **PASS** | Steps 7, 8, 9 — 3/3; artifact `verification=PASS` |
| 10 | Verification gate proven real (not rubber-stamped) | **PASS** | 7 tasks parked in `REQUIRES_REVIEW` with written findings and **no artifact published** |
| 11 | Realtime / SSE proven live | **PASS** | `GET /runtime/events` → HTTP 200 `text/event-stream`; `connected` at 0.2s; `coworker` state events `RUNNING`→`VERIFYING` at 13.3s / 18.4s while REST polled |
| 12 | Reload persistence + logout/login recovery | **PASS** | 9/9 runs |
| 13 | Timings measured (not estimated) | **PASS** | §C below |
| 14 | Known limitations disclosed | **PASS** | §F below; mirrored in runbook §9 |
| 15 | Backup plan for a slow or failing step | **PASS** | Runbook §6 and §8 |
| 16 | Build / test gates green | **PASS** | §B below |
| 17 | No deploy / commit / push performed | **PASS** | §E below |
| 18 | No invented LOCAL / preview / Kuberns surface | **PASS** | All three listed in runbook §7 as "do not show" |

**Gate result: 18 / 18 PASS.**

---

## §23 — A–J REPORT

### A. DEMO PATH

One URL, one account, one task, one artefact.

1. `https://codeconclave-api.onrender.com` → HTTP 200 (warm-up first: Render Free sleeps).
2. Register → 201 in ~2.1s, session issued immediately, **no email-verification gate**.
3. Access check → demo mode, no payment, no entitlement wall.
4. Create project → 201, no 402.
5. Create task with the runbook §4 prompt → 201, `executionMode=CLOUD`.
6. Planner emits a 2-stage `RESEARCH → DOCS` plan with per-stage `acceptanceCriteria`.
7. Specialists execute; SSE streams `coworker` state changes; UI falls back to polling on drop.
8. Verifier returns `RESEARCH: PASS`, `DOCS: PASS`.
9. Task → `COMPLETED`, transitions `CREATED > RUNNING > COMPLETED`, single attempt.
10. Artifact persisted: `research-the-csv2json-command-line-flags-output.md`, `verification=PASS`.
11. Plan / timeline / artifacts / audit / memory / reload / re-enter / logout→login all verified.

**Why this prompt:** it steers the planner to a research+documentation-only pipeline, excluding `REVIEWER` and `TESTER`. That matters — see §F(3).

### B. TEST RESULT

This session (live and local):

| Gate | Result |
| --- | --- |
| Desktop test suite | **73 / 73 passed** |
| Backend TypeScript compile | **0 errors** |
| Boot smoke + hub security | **24 / 24** |
| Frontend production build | **OK** (10.05s, demo build) |
| Demo-mode contract suites (App, earlyAccess, entry-auth, LandingPage, AuthProvider) | **84 / 84** |
| Deployed bundle security scan (payment + Google indicators) | **0 forbidden hits**, demo-mode indicators present |
| Live rehearsals, fixed stages (1–5, 7–14) | **109 / 109 PASS across 9 runs, 0 failures** |

Carried forward from the completed engineering pass (`MASTER_PASS_REPORT.md`): frontend 595/595 · backend 4242 passed / 3 env-fail / 76 skipped · P0 anchors 43/43 · verification 77/77 · contracts 100/100 · RLS/durability 74 · hub security 23/23 · adversarial 54/54 · security 98/98.

### C. TIMINGS

Per-stage live measurements (9 rehearsals, min–max):

| Stage | Measured |
| --- | --- |
| 1. Open landing (cold) | 505–669 ms |
| 2. Register | 1783–2284 ms |
| 3. Access check | 251–302 ms |
| 4. Create project | 231–357 ms |
| 5. Create task | 243–357 ms |
| **6. Task execution → terminal** | **86 s – 275 s (canonical prompt)** |
| 7. Plan persisted | 213–503 ms |
| 8. Timeline | 247–338 ms |
| 9. Artifacts | 199–229 ms |
| 10. Audit trail | 217–299 ms |
| 11. Memory | 197–260 ms |
| 12. Reload persistence | 165–181 ms |
| 13. Re-enter workspace | 192–240 ms |
| 14. Logout → login | 2192–2344 ms |
| **Full rehearsal** | **94 s (fast) – 282 s (slow)** |
| SSE `connected` | 0.2 s |
| SSE first `coworker` event | 13.3 s after task creation |
| Cold start / health wake | up to ~45 s (instance slept) |

### D. FIXES

**None. This pass made no product code change.** It is a read-only demo-lock: it measured the existing system and documented it. Where the system behaved sub-optimally, the behaviour is reported as a limitation (§F) rather than patched, because patching would have violated the "no new product feature / no deploy" constraints.

Two problems were *diagnosed* rather than fixed:

1. Tasks whose plan contains `REVIEWER` almost always park in `REQUIRES_REVIEW` — by design, the reviewer is prompted *"Never rubber-stamp"* and the gate publishes nothing on any `FAIL`. Workaround: the runbook §4 prompt produces a plan without `REVIEWER`.
2. Repeated retries exhaust the attempt budget and degrade a task to `TIMED_OUT`. Workaround: runbook §7 forbids retrying more than once.

### E. FILES CHANGED

This session created exactly three files, all documentation:

- `SATURDAY_DEMO_RUNBOOK.md` (new)
- `KUBERNS_DEMO_TALK_TRACK.md` (new)
- `SATURDAY_DEMO_GATE_REPORT.md` (this file, new)

**No source file was modified. No deploy, no commit, no push.** `git status` still shows the uncommitted working-tree changes carried over from the previous engineering pass (including `orchestrator.ts`, `watchdog.ts`, durable-state modules); this session did not touch, stage or commit any of them. Branch `temporary-demo-mode`, HEAD `9a4b33b`.

Temp tooling stayed outside the repo in `%LOCALAPPDATA%\Temp\opencode\` (`rehearse.mjs`, `inspect.mjs`, `retry.mjs`, `batch.mjs`, `realtime.mjs`, `sse.mjs`, `status.mjs` plus their JSON/log evidence).

### F. LIMITATIONS

1. **Render Free sleeps when idle.** Cold start up to ~45s. The host is not always-on — disclose this; do not claim uptime or SLA.
2. **Production runs `96b4241`, not HEAD `9a4b33b`.** The heartbeat fix exists in the repo but is **not deployed** (deployment was out of scope). Observed impact across 15 task-execution observations: no watchdog reset.
3. **Completion is plan-dependent.** 15 live task-execution outcomes: **4 `COMPLETED`**, 7 `REQUIRES_REVIEW`, 2 `TIMED_OUT`, 1 `FAILED` (dead-lettered), 1 transport abort. The canonical runbook prompt is 3/3 `COMPLETED`; other prompts are not.
4. **Tasks execute serially.** Creating a second task while the first runs leaves it in `CREATED` for minutes. One task at a time.
5. **AI-router failures are real.** Observed live: `"No model currently satisfies the request (entitlement/capability/privacy/health)"` → after 3 attempts the task dead-letters with `dlq=yes`.
6. **Memory is empty on a new account.** Shown as honest-empty. No seeded data exists anywhere in demo mode.
7. **LOCAL runtime, preview environments and any Kubernetes/Kuberns runtime are not working features** and must not be shown.
8. **SSE is proven for `coworker` state events on `/runtime/events`**; task-level SSE reconnection under a forced network drop was covered by unit tests in the engineering pass, not re-forced live in this pass.

### G. TALKING POINTS

Defensible, in priority order:

1. **Project-first workbench, not a chat box** — project → task → plan → specialist runs → timeline → artifacts → audit are separate inspectable surfaces.
2. **Specialists execute a plan with acceptance criteria attached** — live plan produced 2 stages, each carrying its own criteria, executed as distinct coworker runs.
3. **Verification is real and allowed to say no** — 7 tasks were parked with written findings and *no artifact published*; the gate never claims work it did not certify.
4. **Real persisted artifacts** — hashed, tied to run and attempt, survive reload and logout/login.
5. **Realtime** — SSE streams specialist state changes; polling fallback keeps the UI correct if the stream drops.
6. **Everything is audited** — 6+ genuine events per rehearsal, real rows rather than counters.
7. **Honest empty states** — memory returns `{memories:[],total:0}` instead of fabricated content.
8. **Demo mode is explicit** — `reason: TEMPORARY_DEMO_MODE`, no payment, no card, no entitlement wall; Google sign-in off the customer surface.
9. **Kuberns framing** — *planned strategic deployment boundary*; control plane runs as a managed service today; the control-plane/execution-substrate separation is what makes a Kubernetes move tractable.
10. **Honesty as the product thesis** — the single strongest line available: *"it refused to publish work it could not verify."*

### H. BACKUP PLAN

- **Time short (2 min):** log in with the pre-proven account (`demo9.20261008-181306@codeconclave.app` / `Demo202610089a`), open completed task `tsk_7csmwh6qkmc8qco6w26m`, show plan → verdicts → artifact → audit. Zero live risk.
- **Task parks in `REQUIRES_REVIEW`:** present it as the gate working; open the reviewer's actual finding; retry **once** only.
- **Slow cold start:** use the runbook §2 warm-up 10 minutes early; keep the tab open.
- **Second task stuck in `CREATED`:** expected — the queue is serial. Show the first task instead; do not create a third.
- **Complete failure of the execution segment:** steps 1–5 and 7–14 (109/109 observed) still carry the whole "real app, real account, real project, real audit" story on their own.

### I. DEPLOYMENT READINESS

- **The live environment is already the demo environment.** No deployment is required for Saturday, and none was performed.
- Repo HEAD (`9a4b33b`) is one commit ahead of what production runs (`96b4241`). That delta is the heartbeat fix — desirable, **not required** for this demo, and explicitly not deployed in this pass.
- The working tree carries uncommitted changes from the previous engineering pass. They are neither staged nor committed and must stay that way through the demo window.
- `render.yaml` already carries `TEMPORARY_DEMO_MODE: "true"` and `VITE_DEMO_BUILD: "1"` as value keys (not `sync: false`), so the demo configuration is source-controlled rather than a console-only secret.
- Recommendation: **do not deploy, commit, push, or touch Render config during the demo window.**

### J. GO / NO-GO

## **GO**

Conditions (all mechanical, all in the runbook):

1. Warm the instance 10 minutes early (runbook §2).
2. Use the **exact** runbook §4 prompt — it is the only prompt verified 3/3 to `COMPLETED`.
3. Create **one** task at a time; never retry more than once.
4. Follow the runbook §7 "do not show" list (LOCAL, preview, Google sign-in, billing, second concurrent task, git/Render).
5. If the task parks in `REQUIRES_REVIEW`, present it as the gate working — do not claim completion.

Confidence, stated honestly:

- **High** — landing, register, demo-mode entitlement, project and task creation, plan, timeline, audit, memory, reload, re-enter, logout/login: **109/109 live checks, zero failures.**
- **High** — payment and Google OAuth absent from the deployed surface and from the API contract: verified by bundle scan and live endpoint responses.
- **High** — realtime SSE: proven live.
- **Medium** — a task reaching `COMPLETED` *at all*: only 4/15 exploratory outcomes did, **but the canonical demo prompt is 3/3**, and a pre-completed backup task exists for the fallback.
- **Disclosed** — cold starts, serial queue, provider failures, absence of LOCAL/preview/Kuberns: all in runbook §9 and talk track §7.

**STOP.** No deploy, no commit, no push, no production infra change, no new feature. Demo-lock report complete.
