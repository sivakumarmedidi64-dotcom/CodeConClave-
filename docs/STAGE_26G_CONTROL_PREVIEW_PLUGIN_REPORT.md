# STAGE 26G — CONTROL PLANE + PREVIEW WORKSPACE + PLUGIN SANDBOX — IMPLEMENTATION REPORT

Date: 2026-08-19 — Backend + frontend slice for Stage 26G (risk policies, kill switch, undo, secret guard, usage analytics, preview review workspace, plugin action sandbox).

All work extends the existing codebase. No greenfield replacements, no fake functionality — preview renders only real build output, sandbox output is explicitly labelled simulated, ROI is labelled an estimate, and the kill switch only stops new work. Every subsystem reuses the existing task engine (`createTask`), approvals (`proposeApproval`), audit, notifications, entitlements and the plugin isolation boundary. Migration count: **51/51 applied live** (0051 added). No deployment was performed.

## Implemented (backend)

### Schema (`database/migrations/0051_stage26g_control_plane.sql`)
- `kill_switch` — per-scope suspension: owner/scope (GLOBAL/AGENTS/TASKS/SCHEDULES/AUTONOMY, CHECK-constrained), active, reason. RLS owner policies, unique (owner_id, scope).
- `control_policies` — risk policies: scope (task/plugin/schedule/automation/agent/global), action, risk_level (LOW..CRITICAL), requirement (require_approval/block), enabled. Unique (owner_id, scope, action).
- `undo_log` — reversible-action journal: action_type (kill_switch_toggle/policy_toggle/plugin_scope_change), description, payload (jsonb), status PENDING/APPLIED/FAILED, result. CHECK on action_type/status.
- `secret_guard_scans` — scan runs: target_type (agent_output/file/commit/memory/task_payload), target_ref, matched, `findings` (jsonb: kind/location/confidence/preview — **never the secret value**).
- `preview_comments` — review comments: preview_version, selector, comment, task_id (each comment creates a real MEDIUM-risk task), status OPEN/RESOLVED.
- `preview_snapshots` — one row per (project, version), state + build_log jsonb; unique (project_id, version).
- `plugin_sandbox_runs` — sandbox executions: plugin_type, action, status (SUCCESS/FAILED/UNKNOWN_ACTION), output/error, `simulated` (always true — the field exists so consumers can never claim otherwise).
- `usage_ledger` — per-call AI cost entries (session_id, task_id nullable, feature, model_id, input/output tokens, cost_usd) — existing ledger reused; `usage_rollups` — additive daily aggregates keyed (owner, bucket, feature, COALESCE(task_id,'__none__')).

### Control plane (`backend/src/modules/control/`)
- `killSwitch.ts` — `killSwitchActive`/`assertAutonomyEnabled` (throws `autonomy_suspended`), `setKillSwitch` (audits `kill_switch.toggled`, notifies `kill_switch.activated`), `killSwitchStatus`. The kill switch only gates NEW work — in-flight work is never interrupted.
- `policies.ts` — `evaluatePolicy` (risk-rank strictest matching rule, wildcard `*` action, BLOCK/require_approval), `upsertControlPolicy`/`deleteControlPolicy`/`listControlPolicies` (upsert ON CONFLICT (owner_id, scope, action)). Policy eval audits `policy.evaluated`.
- `undo.ts` — only genuinely reversible kinds are recordable (`kill_switch_toggle`/`policy_toggle`/`plugin_scope_change`; anything else is rejected at record time); `undoAction` dispatches to the real reversers (setKillSwitch, upsertControlPolicy, updateConnectionScopes).
- `routes.ts` — `/api/v1/control`: policies CRUD, kill-switch GET/PUT, undo list/record/execute, secret-guard scans + scan, usage (cost-per-feature, cost-per-task, ROI, transparency, rollup refresh + list), activity heatmap, **proof-of-work GET/POST** (`/pow/:taskId`, `/pow`), plugin sandbox runs + run.

### Gates integrated (server-authoritative, all audited)
- `createTask` (execution/tasks.ts) — `assertAutonomyEnabled('TASKS')` + `evaluatePolicy('task','create',riskLevel)`: BLOCK ⇒ `policy_blocked`; require_approval ⇒ risk escalated to HIGH (existing approval machinery takes over).
- `createSchedule` (scheduling/service.ts) — autonomy gate `SCHEDULES`.
- `startRun` (agents/service.ts) — autonomy gate `AGENTS`.
- `createRule` (automations/rules.ts) — autonomy gate `AUTONOMY`.
- `executePluginAction` (plugins/engine.ts) — `evaluatePolicy('plugin', def.permission, 'MEDIUM')`: BLOCK ⇒ `policy_blocked`; require_approval ⇒ `proposeApproval` (ApprovalActionType.PLUGIN_ACTION) then `plugin_policy_approval_required` with the approval id surfaced.

### Preview workspace (`backend/src/modules/preview/`)
- `comments.ts` — list/add/resolve; every comment creates a real task through the existing engine (`Preview comment: <selector>`, MEDIUM risk) and audits `preview_comment.created`/`preview_comment.resolved`.
- `snapshots.ts` — `capturePreviewSnapshot` (best-effort, never throws, dedupes by (project, version)) and `previewVisualDiff` — honest: returns the two most recent real snapshots, `available:false` when fewer than two exist (no fabricated before/after).
- `proofOfWork.ts` — `generateProofOfWork`/`getProofOfWork` build a report from **real persisted state only** (plan, files, tests, attempts/errors/artifacts, preview state, approvals, time, AI usage); the plan query was fixed to pass `[taskId]`.

### Secret guard (`backend/src/modules/secretGuard/service.ts`)
- 11 credential patterns (OpenAI/GitHub/AWS/GCP/Azure/Slack/Twilio/Stripe/Generic API key, JWT, private key). `scanContent` stores findings as kind/location/confidence/preview only — **values are never persisted**; `redactSecrets` supports caller-side redaction. Findings audit `secret_guard.finding_detected` + notify `secret_guard.finding_detected`.

### Plugin sandbox (`backend/src/modules/plugins/sandbox.ts`)
- `runPluginSandbox` validates the action against the real adapter registry (`getAction`); unknown actions ⇒ `sandbox_action_unknown`. Output is **clearly labelled simulated** (a fake payload wrapped with a `simulated: true` marker) — it never claims a provider call was made. Runs are persisted tenant-scoped.

### Usage analytics (`backend/src/modules/usage/analytics.ts`)
- `featureForSession` maps real session prefixes (task:/agent:/chat:/preview:/plugin:/... and coworker_type) to UsageFeature values; `costPerFeature`/`costPerTask` aggregate the real ledger; `roiEstimate` = tasks × $5 − AI cost, **labelled an estimate**; `transparencyLog` lists every AI call; `changeHeatmap` joins real file activity per project per day; `refreshUsageRollups` aggregates the ledger into additive rollups (ON CONFLICT DO UPDATE SUM).

### Wiring
- `backend/src/app.ts`: `app.use('/api/v1/control', controlRoutes())`.
- preview routes extended: comments GET/POST, resolve, snapshots POST, diff GET.
- `shared/src/constants.ts`: 15 new AuditAction values (`kill_switch.toggled`, `policy.upserted`, `policy.deleted`, `policy.evaluated`, `undo.recorded`, `undo.applied`, `undo.failed`, `secret_guard.scanned`, `secret_guard.finding_detected`, `preview_comment.created`, `preview_comment.resolved`, `preview_snapshot.captured`, `proof_of_work.generated`, `plugin.sandbox_run`, `plugin.policy_blocked`) + 3 NotificationType values (`kill_switch.activated`, `secret_guard.finding_detected`, `preview_comment.created`); shared rebuilt (dist).
- `backend/src/shared/ids.ts`: PREFIX `ksw` / `cpl` / `udl` / `sgs` / `pco` / `sbr` / `rpl` (usage_rollups id).

## Tests

### New suite `backend/src/foundation/control-26g.test.ts` — **38/38 green** (8 describes, table-driven harness with 23 tables incl. JSONB set, INSERT ON CONFLICT DO UPDATE, DELETE, heatmap JOIN and IN(...) matching branches)
- Preview: comments create real tasks (asserted via the engine mock), list/resolve lifecycle, tenant isolation; snapshots dedupe by version; visual diff honest (`available:false` with <2 snapshots).
- Proof of work: report built from real task/plan/files state; generation + retrieval.
- Kill switch: suspend/resume per scope, `autonomy_suspended` thrown on gated calls, audits + notifications, global scope overrides, reason recorded.
- Policies: evaluate (exact + wildcard + risk-rank), upsert/delete, `policy_blocked` thrown from the plugin engine BLOCK gate; require_approval escalates task risk to HIGH (approval flow asserted).
- Undo: reversible kinds only (kill switch/policy/plugin-scope), non-reversible rejected at record time, undo actually re-applies the prior state (switch off/on, policy re-upsert, scopes restored).
- Secret guard: 11-pattern detection with kind/location/confidence, no value persisted, clean scans, tenant isolation.
- Plugin sandbox: known action ⇒ simulated output labelled, unknown action ⇒ `sandbox_action_unknown`, runs listed.
- Usage analytics: cost per feature/task from the real ledger, ROI estimate ($5/task label), transparency log, heatmap merges same-day changes, rollup refresh additive on repeat (feature + per-task rows), tenant isolation.

### Full regression
- Backend: **85 files, 1369 tests, 1366 passed / 3 skipped / 0 failed** (perf-17 timing smoke skipped under full-suite load — passes in isolation; same known flake as 26F).
- Frontend: **42 files, 244 passed** (incl. 10 new: WorkspacePage CHAT/CODE/PREVIEW, ControlPage, Sidebar 21-item order).
- local-agent: 5 files / 49 passed.
- Typecheck: shared + backend + frontend + local-agent EXIT 0; builds: shared + backend + frontend EXIT 0.

## Frontend
- **WorkspacePage** (`/workspace`) — CHAT (task composer through the real execution engine + recent tasks), CODE (real file tree, change heatmap, proof-of-work selector/generator), PREVIEW (existing `PreviewPanel` reused untouched + comment box with task linkage + snapshot capture + honest visual diff).
- **ControlPage** (`/control`) — kill switch per scope with reason, policy table + upsert/delete, undo log with execute, secret guard scan form + finding history (values never rendered back), usage: cost-per-feature/task, ROI (labelled estimate), transparency log, rollup refresh.
- **PluginsPage** — new Action Sandbox section (plugin type + action + JSON input → `/api/v1/control/plugins/sandbox/run`), output explicitly labelled simulated; runs history.
- Sidebar: 21 items (Workspace, Control Plane added); routes wired in `App.tsx`.

## Failures found & fixed during the slice
- Harness compatibility for earlier suites: `engineering-26f`/`recovery-26e` assumed every table existed — patched with defensive missing-table guards (UPDATE/SELECT/COUNT/MAX/DELETE branches); resolve-based harnesses were already safe. 5-suite regression verified (136 tests).
- Rollup test failure: the harness split `ON CONFLICT (…, COALESCE(task_id,'__none__'))` on commas, splitting inside the COALESCE and collapsing the per-task row into the feature row (additive double-count) — the conflict-column parser now tokenizes COALESCE-aware (`/COALESCE\((\w+),'__none__'\)|\b(\w+)\b/g`).
- Plugin sandbox tests: adapters register via `registerPlugins()` (not on import) — tests call it in `beforeEach`; plugin scopes are `PluginPermission` values (`read`/`write`/`admin`), not resource strings.
- Typecheck (5): policy requirement cast, `UNDOABLE_KINDS` tuple cast in routes, `ApprovalActionType` import + `proposeApproval` argument shape, `AppError.forbidden` two-arg form.
- Frontend tests: ToastProvider wrapper required; label text split across elements (matched via `getByLabelText`/regex); stateful fetch handlers so refetched lists persist after POSTs.

## Limitations / deferred
- Live provider-backed preview builds and plugin actions cannot be observed (build tooling/provider credentials unavailable in this environment) — preview states render the honest NOT_CONFIGURED/OFFLINE paths; sandbox is simulated by design.
- ROI uses a fixed $5/task value model and is explicitly labelled an estimate; no claims of realised returns.
- Secret-guard pattern set is deterministic and intentionally conservative (11 patterns) — broader coverage can extend the list without schema changes.

## Next steps (per continuation prompt)
Stage 26G is complete per the prompt (control plane, preview workspace, plugin sandbox, secret guard, usage/payment completion). **STOP — no deployment; do not begin 26H.**