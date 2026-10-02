# STAGE 26I — FRONTEND UX FOR THE 26-BACKEND-CAPABILITY SURFACE — IMPLEMENTATION REPORT

Date: 2026-08-20 — Stage 26I turns the backend capabilities completed through 26H into coherent frontend UX. No architecture rebuild, no unnecessary component replacement, no deployment. Every surface renders server state only — honest statuses, clear errors, no fake progress, no infinite "Thinking". All 22 surfaces from the Stage 26G gap analysis are now reachable from the UI, and the whole product is regression-verified at desktop, tablet and mobile widths.

## What shipped

### Agent workspace — `AgentsPage` (3 tabs)
- **Agents** (existing) — unchanged.
- **Debate** (`components/DebatePanel.tsx`) — list debates, create a debate (2–5 IDLE proposers + judge + prompt + optional budget; judge is chosen from non-proposers), live detail with per-round proposals, spend, judge rationale, cancel while running, and Approve/Reject for `WAITING_FOR_APPROVAL`. 10s auto-refresh only while a debate is live — no polling once settled. Everything rendered from server records (`/api/v1/agents/debates`, `/debates/:id` → `{debate, proposals}`, `/debates/:id/cancel`, `/decide`).
- **Marketplace** (`components/MarketplacePanel.tsx`) — catalogue browse (search + role filter), declared permissions / trust / plan gates shown verbatim, install creates a real agent (`POST /marketplace/:id/install` with `agentName` + `trustLevel`), then manage installed agents: disable / enable / update / uninstall. Installed rows show the linked agent + package from the server.

### Memory workspace — `MemoryPage` (2 tabs)
- **Memories** (existing) — unchanged.
- **Explorer** (`components/MemoryExplorerPanel.tsx`) with three sub-tabs:
  - **Decisions** — recorded decisions (impact, rationale, consequences), replay a query (`POST /decisions/replay`), record a decision.
  - **Conflicts** — detect conflicts for a request text, open conflicts with the source decision, resolve with an explicit decision (KEEP / REPLACE / EXCEPTION / CANCEL) and note.
  - **Continuity** — cross-project pattern memory opt-in (read-only suggestions from your own projects, never auto-applied), handoff generation from live state (`GET /handoffs/generate?projectId=` then `POST /handoffs`), and the server-recorded 24h timeline.

### New `/automation` page (`pages/AutomationPage.tsx`)
- **Schedules** — list (with the server's human-readable cadence description), create (ONCE with datetime / WEEKLY day picker / CRON expression, agent + optional project, execution mode, missed-run policy), pause / resume / run-now, delete, and per-schedule run history.
- **Goals** — goal list with server statuses, plan stages and progress, create with success criteria + constraints + budget + require-approval, generate plan, start / pause / resume / cancel, and Approve/Reject for `WAITING_FOR_APPROVAL`.
- **Escalations** — open escalations with server-provided options and recommendation, decide (APPROVE / REJECT / EDIT_PLAN / RETRY / PAUSE / CANCEL).

### New `/recovery` page (`pages/RecoveryPage.tsx`)
- Project + task picker (task list comes from `/api/v1/execution/tasks?projectId=` — honest, requires the real project).
- **Autopsy** — server autopsy for the task (root cause, confidence, timeline, attempts, prevention), generate a new autopsy, full autopsy + recovery history lists.
- **Time Travel** — checkpoints (label/reason/stage/plan state), create a checkpoint snapshot, branch from a checkpoint or current state, rewind to a checkpoint — all via the recovery API, returning the branched task id.

### First win — `HomePage`
- `components/FirstWinCard.tsx` — an onboarding banner read strictly from live API state: "Create your first project / Create your first agent / Run your first task" check only what the server reports; the card disappears once a project AND an agent exist. "Set up a demo project" creates a **real** project + agent through the normal APIs (then navigates to the agent workspace) — nothing simulated.

### Shell
- Routes `/automation` and `/recovery` in `App.tsx`; `Sidebar` is now the frozen 23-item order (Automation after 24/7 Work, Recovery after Data Centre); `Sidebar.test.tsx` updated to the 23-item assertion.

## Tests — frontend

| Suite | Tests | Notes |
|---|---|---|
| `AgentsPage26I.test.tsx` | 6 | debate list/proposals, create (proposers+judge), approve; marketplace browse, install, disable/uninstall |
| `MemoryPage26I.test.tsx` | 6 | decisions list/replay/record; conflicts detect/resolve; continuity handoff + timeline |
| `FirstWinCard.test.tsx` | 4 | empty state, hides when both exist, partial check marks, demo seeding through real POSTs |
| `AutomationPage.test.tsx` | 8 | schedules CRUD + runs, goal create/plan/approve, escalation decide |
| `RecoveryPage.test.tsx` | 6 | idle state, autopsy view/generate, checkpoints/branch/rewind |
| `AppResponsive.test.tsx` | 4 | desktop collapse, tablet hamburger, mobile drawer open/close + close-on-navigate |

Full frontend suite: **48 files, 279 passed** (baseline 42/245 → +6 files, +34 tests).

## Failures found & fixed during the slice
- Test fixtures didn't match the real API shapes: goal `POST /goals` (no trailing slash) returned the list shape so plan generation read `undefined.id`; a `PLAN_READY` fixture renders no Approve button (approve requires `WAITING_FOR_APPROVAL`); debate fixtures needed a non-proposer judge; marketplace fixture pre-installed the package so "Install" was correctly absent.
- Latent crash exposed by the new tests: `MemoryPage` and `ProjectsPage` read `.length` on possibly-undefined response arrays under the generic `{data:{}}` shell fallback → defensive `?? []` in both (and in RecoveryPage/AutomationPage guards).
- Unhandled-error hygiene: `toHaveBeenCalledWith` arity (fetch always receives 2 args) and handler ordering (`/decisions` matched `/decisions/conflicts` first) — both fixed in the tests.
- No backend changes were needed; all shapes matched the routes confirmed in 26G/26H.

## Full regression
- Backend: **88 files, 1422 tests — 1419 passed / 3 skipped / 0 failed** (perf-17 timing flake under full-suite CPU contention; passes in isolation, known pattern).
- Frontend: **48 files, 279 passed**; typecheck EXIT 0; build ✓.
- local-agent: 5 files / 49 passed; typecheck EXIT 0; build EXIT 0.
- Shared: builds clean (no changes this stage).

## Limitations / deferred (honest)
- Live debate runs, goal plan generation and marketplace installs require a configured AI provider + agents; the UI renders whatever the server returns (statuses like `IN_DEBATE`, `PLANNING`, `WAITING_FOR_APPROVAL`) and surfaces errors via toast — it never fabricates outcomes.
- Recovery is destructive: branch/rewind call the server endpoints and show server results; no client-side simulation or dry-run UI was added (server-owned).
- The responsive drawer is CSS-driven (breakpoints 1024/768, pre-existing); the new journey tests assert the shell behaviour (collapse at desktop/tablet, drawer at mobile) rather than pixel layout.