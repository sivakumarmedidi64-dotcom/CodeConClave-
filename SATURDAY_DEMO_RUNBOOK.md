# SATURDAY DEMO RUNBOOK — CodeConClave (2:00 PM Kuberns demo lock)

Status: **GO** (with the known limitations in §9 — read them before going live)
Evidence base: 9 live rehearsals against production on 2026-10-08 (details in `SATURDAY_DEMO_GATE_REPORT.md`).
Nothing in this file is theoretical. Every step below was executed against the live URL.

---

## 1. Environment

| Item | Value |
| --- | --- |
| Demo URL (serves app + API) | `https://codeconclave-api.onrender.com` |
| Health check | `https://codeconclave-api.onrender.com/health` → HTTP 200 |
| Deployed commit | `96b4241` (parent of `9a4b33b` — heartbeat fix is **not** deployed) |
| Demo entitlement | `TEMPORARY_DEMO_MODE=true` → no payment, no card, no upgrade prompt |
| Demo build flag | `VITE_DEMO_BUILD=1` → Google OAuth removed from customer login surface |
| Runtime | Render **Free** instance → cold sleeps when idle |

**Never** touch production infra, secrets, config or git during the demo. This pass made **no** deploy, **no** commit, **no** push.

## 2. Warm-up (do this 10 minutes before 2:00 PM)

1. Open `https://codeconclave-api.onrender.com/health` — confirm HTTP 200 and `API / Database / Redis / Queue / Worker / AI providers / Storage` are HEALTHY.
2. Open the app root once and leave the tab open (first request wakes the instance; cold start observed up to ~45s).
3. Re-open the health URL to confirm it answers in under ~2s. If it is still slow, repeat step 1 once.

> **Why:** the instance sleeps when idle. Waking it *during* the demo costs you 30–45 seconds of dead air.

## 3. Demo account

**Recommended: register live** (it is 2.1s, always passes, and proves there is no email-verification gate).

**Backup account** (already proven end-to-end, task COMPLETED with a persisted artifact):

| Field | Value |
| --- | --- |
| Email | `demo9.20261008-181306@codeconclave.app` |
| Password | `Demo202610089a` |
| Project | `prj_x03sjc49usly93sdxrhz` |
| Task (COMPLETED) | `tsk_7csmwh6qkmc8qco6w26m` |
| Artifact | `research-the-csv2json-command-line-flags-output.md` (verification `PASS`, 1687 bytes, sha `c27c5ade14b16a91…`) |

If you use the backup account, skip straight to §5 step 6 — the finished task and artifact are already there to show.

## 4. The exact task prompt (copy-paste — this is the proven one)

**Title**

```
Research the csv2json command line flags
```

**Description**

```
Produce a reference list of every command line flag supported by the csv2json
tool. The deliverable is a single markdown table with three columns: Flag,
Type, Default. Rows: --delimiter string comma; --header boolean true; --quote
string double quote; --pretty boolean false; --help boolean none. This is a
factual research and documentation task only — there is no code to build, test,
secure or review, so skip the ARCHITECT, CODER, TESTER, SECURITY and REVIEWER
stages and use research plus documentation only. Output the complete table in
full.
```

**Why this prompt:** it steers the planner to a 2-stage `RESEARCH → DOCS` pipeline. Both stages verify `PASS`, the artifact persists, and the task reaches `COMPLETED`. This is 3-for-3 live. Do not improvise a different prompt on stage — see §9 for what happens.

## 5. The live sequence (~8–10 minutes)

Times are measured, not estimated. Ranges are across all 9 rehearsals.

| # | Action | Expected | Time | Fallback if wrong |
| --- | --- | --- | --- | --- |
| 1 | Open the URL (cold) | HTTP 200, title `CodeConClave`, no secrets/debug text | 0.5–0.7s (cold start up to ~45s) | Re-run §2 warm-up |
| 2 | Register (email + password) | 201, session cookie set, **no** email-verification wall | 1.8–2.3s | Use §3 backup account |
| 3 | Land in workspace / access check | `temporaryDemoMode=true`, `paymentRequired=false`, `purchaseEnabled=false` | 0.25–0.30s | Refresh |
| 4 | Create project | 201, project id returned, **no 402** | 0.23–0.36s | Refresh, retry once |
| 5 | Create the task (§4 prompt) | 201, task id, `executionMode=CLOUD` | 0.24–0.36s | Check you are in the right project |
| 6 | **Watch it run** | plan → `RESEARCH` → `DOCS` → verify → `COMPLETED` | **86–275s (allow up to 5 min)** | Go to §6 |
| 7 | Open the plan | 2 entries, structured JSON, non-empty `acceptanceCriteria` | 0.21–0.50s | Refresh |
| 8 | Open the timeline | 1 attempt, 5 steps, 2 coworker runs | 0.25–0.34s | Refresh |
| 9 | Open artifacts | 1 artifact, `verification=PASS` | 0.20–0.23s | Refresh |
| 10 | Open audit trail | 6+ real events (`task.created`, `project.created`, `dna.created`, …) | 0.22–0.30s | Refresh |
| 11 | Open memory | `{memories:[], total:0}` — honest empty, never a fake counter | 0.20–0.26s | Nothing to do; say it is empty because the account is new |
| 12 | Reload the page | same user still authenticated | 0.17s | Log in again |
| 13 | Re-enter workspace | project still listed, no paywall | 0.19–0.24s | — |
| 14 | Log out → log in | 200 + 200, session restored, same user | 2.2–2.3s | — |

**Total observed:** 94s (fast run, 86s execution) to 282s (slow run, 274s execution).

### What to point at while it runs

- **The plan appearing** — structured stages, each with its own `acceptanceCriteria`.
- **SSE updates** — proven live: `coworker` events stream with `state: RUNNING → VERIFYING` (observed at 13.3s and 18.4s after task creation). If the stream drops, the UI falls back to REST polling, which is the same path the runbook timings come from.
- **The verification verdict** — `RESEARCH: PASS`, `DOCS: PASS`, and the artifact row's own `verification: PASS`.
- **The audit trail** — every action recorded as a real event.

## 6. If step 6 does not reach `COMPLETED` (honest handling)

The verification gate is real. If a specialist's output does not satisfy its acceptance criteria the task parks in `REQUIRES_REVIEW` and **writes no artifact** — that is correct behaviour, not a broken demo.

**Say this:** *"The gate refused to publish. Here is exactly which stage failed and why — it will not claim success it did not earn."* Then open the coworker run and show the reviewer's actual written finding. This is a strength of the product, and this pass deliberately did not weaken it.

**Then, if you still want a green task:** click **Retry** once. Observed: one retry is safe; repeated retries burn the attempt budget and the task degrades to `TIMED_OUT`. Never click retry a third time on stage.

## 7. Do NOT click / do NOT show

| Surface | Reason |
| --- | --- |
| **LOCAL runtime** | Architecture is missing — shows `ARCHITECTURE MISSING`. Not a demo surface. |
| **Preview** | Unconfigured in this deployment. |
| **Google sign-in** | Removed from the customer surface for the demo (plugin connectors only). Do not walk into integrations → Google. |
| **Payment / Upgrade / Checkout** | Neutralized for the demo. Do not open billing or receipt screens. |
| **Creating a 2nd task while the 1st is running** | Tasks queue **serially**; a second task sits in `CREATED` for minutes. Create one task at a time. |
| **Retrying a task 3+ times** | Exhausts attempts → `TIMED_OUT`. |
| **Anything in Render / git / CI** | This pass made no deploy, no commit, no push. Neither should you. |

## 8. Backup plan (if you have 2 minutes instead of 10)

1. Log in with the §3 backup account.
2. Open the pre-completed task `tsk_7csmwh6qkmc8qco6w26m`.
3. Show, in order: the plan (2 stages, real criteria) → the two `PASS` verdicts → the artifact with `verification=PASS` → the audit trail.
4. Say: *"That task completed in 86 seconds on the live production URL this morning."*

That is the whole story with zero live risk.

## 9. Known limitations — disclose these, do not hide them

1. **Render Free sleeps when idle.** The instance is not always-on. First hit of the day can take up to ~45s. This is a hosting tier, not a product defect.
2. **Production runs `96b4241`** — the heartbeat fix `9a4b33b` is in the repo but **not deployed** (deployment was out of scope for this pass). Observed impact in 14 live task runs: none.
3. **Task completion depends on the plan.** If the planner includes `REVIEWER`, the reviewer is prompted *"Never rubber-stamp"* and will usually return `FAIL` → `REQUIRES_REVIEW`. The §4 prompt avoids that by requesting a research+documentation-only plan.
4. **Tasks run serially.** One at a time.
5. **Occasional AI-router errors** were observed live: `"No model currently satisfies the request (entitlement/capability/privacy/health)"`, which can dead-letter a task after 3 attempts (`dlq=yes`). Rare, but real.
6. **Memory is genuinely empty** on a new account. Show it as honest-empty, not as a populated feature.
7. **Not claimed, not shown:** LOCAL execution, Kubernetes/Kuberns runtime, preview environments, always-on uptime, SLA, 24/7 autonomy.

## 10. Pre-flight checklist (run at 1:45 PM)

- [ ] `/health` returns 200, all core subsystems HEALTHY
- [ ] App root loads (instance warm), tab left open
- [ ] §4 prompt copied and ready to paste
- [ ] §3 backup account verified (log in once, log out)
- [ ] Browser zoom set, dev-tools closed, no admin tabs open
- [ ] §7 "do not click" list read
- [ ] `SATURDAY_DEMO_GATE_REPORT.md` §23 J read (GO/NO-GO)
