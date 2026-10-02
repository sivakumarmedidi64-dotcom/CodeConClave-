# CodeConClave — PKG-17 — Developer Workflow, Development Execution & Deployment/Release Operations

**Derived from:** `docs/CODECONCLAVE_FINAL_MASTER_FEATURE_REGISTRY.md` (Group C Intelligence)
**Theme (user-confirmed):** DEVELOPER WORKFLOW + DEVELOPMENT EXECUTION + DEPLOYMENT/RELEASE OPERATIONS — the complete developer lifecycle: CODE → EDIT → SEARCH → EXECUTE → DEBUG → TEST → PREVIEW → DEPLOY → VERIFY → MONITOR → ROLLBACK.
**Approved to implement:** yes (after PKG-16 COMPLETE + GATED).

> **Honesty model (NON-NEGOTIABLE):** This package delivers **advisory, deterministic
> analyses and planning** for the developer-workflow and deploy/release capabilities.
> It does **NOT** execute deployments, run shell commands, modify the workspace, or
> push to any provider. Where the audit found that a real command-execution /
> deployment-execution primitive does not exist, the capability is delivered as
> **analysis/guidance with an explicit HEURISTIC/UNAVAILABLE state** — never faked as a
> live deploy. No feature is shown as success before backend confirmation.

## Selected cluster

Ten coherent Group C capabilities mapped to the developer lifecycle. All are currently
`PARTIAL`/`MISSING`/`ROADMAP` in the canonical registry. **No registry IDs are invented;
none are shifted from another package.**

| Registry ID | Capability | Lifecycle stage | Current State |
|---|---|---|---|
| #29 | Workspace Migration Agent | CODE / EDIT | MISSING |
| #34 | Documentation Drift Detector | EDIT / TEST | MISSING (only doc *generation* exists) |
| #41 | Contextual Debugging | DEBUG | MISSING |
| #44 | Hotspot Profiler | MONITOR | PARTIAL (`performanceOracle.ts` implemented but unmounted) |
| #31 | Branch Strategy Optimizer | DEPLOY | MISSING (gitNinja branch list is a stub) |
| #32 | Rollback Predictor | ROLLBACK | PARTIAL (`rollbackPlanner.ts` is a feasibility planner, not a predictor) |
| #33 | Hotfix Fast-Track | DEPLOY | MISSING |
| #35 | Feature Flag Orchestrator | DEPLOY control | MISSING (only a toggle getter exists) |
| #43 | Workspace Health Dashboard | VERIFY / MONITOR | MISSING (only infra health exists) |
| #45 | Error Recovery Playbook | VERIFY / ROLLBACK | PARTIAL (`runbookAutomation.ts` execution steps stubbed) |

## Capability table

| Registry ID | Capability | Current Status | Existing Code | Gap | Required Work | Runtime Status |
|---|---|---|---|---|---|---|
| #29 | Workspace Migration Agent | ROADMAP | none | No workspace/codebase migration planning (between stacks/contexts) | `migrationAgent.ts` — advisory migration plan (what moves, risks, steps) over source files; no auto-edit | IMPLEMENTED (deterministic, advisory) |
| #34 | Documentation Drift Detector | PARTIAL | `documentationAutobot.ts` (generates docs); `os/p3/documentation-intel.ts` (AI-OS flag-gated dispatcher) | No drift detection between docs and code (referenced-but-missing symbols, renamed files) | `docDrift.ts` — compare doc text references vs source symbols/files → drift findings | IMPLEMENTED (deterministic, advisory) |
| #41 | Contextual Debugging | ROADMAP | none | No contextual debugging aide | `contextualDebug.ts` — from an error context, surface nearby relevant code + hypothesized cause (read-only) | IMPLEMENTED (HEURISTIC, advisory) |
| #44 | Hotspot Profiler | PARTIAL | `performanceOracle.ts` `generatePerformanceReport` (implemented, unmounted) | Hotspot not exposed via a dedicated dev-workflow surface | `hotspotProfiler.ts` — consume `generatePerformanceReport` → ranked hotspots | IMPLEMENTED (ESTIMATED, advisory) |
| #31 | Branch Strategy Optimizer | ROADMAP | `developer-productivity/gitNinja.ts` (branch list stub) | No branch-strategy recommendation | `branchStrategy.ts` — analyze team/branch data → strategy guidance (advisory) | IMPLEMENTED (HEURISTIC, advisory) |
| #32 | Rollback Predictor | PARTIAL | `deployment-wizard/rollbackPlanner.ts` (feasibility planner) | No rollback-success predictor | `rollbackPredictor.ts` — score rollback readiness/risk from change signals | IMPLEMENTED (HEURISTIC, advisory) |
| #33 | Hotfix Fast-Track | ROADMAP | none | No hotfix fast-track planning | `hotfix.ts` — advisory hotfix plan (minimal change surface, risk, quick verify steps) | IMPLEMENTED (HEURISTIC, advisory) |
| #35 | Feature Flag Orchestrator | ROADMAP | `workspace/service.ts` `getFeatureFlags` (getter) | No flag lifecycle orchestration | `featureFlagOrchestrator.ts` — advisory flag inventory/rollout/evaluate guidance (read-only) | IMPLEMENTED (deterministic, advisory) |
| #43 | Workspace Health Dashboard | ROADMAP | `health/health.ts` (infra health) | No per-workspace development health | `healthDashboard.ts` — aggregate build/test/lint/dep/git signals from source → health score | IMPLEMENTED (HEURISTIC, advisory) |
| #45 | Error Recovery Playbook | PARTIAL | `production-intelligence/runbookAutomation.ts` (execution stubbed) | No recovery playbook generator for common errors | `errorRunbook.ts` — map error signatures → recovery steps (advisory) | IMPLEMENTED (HEURISTIC, advisory) |

## Out of scope (preserved — NOT removed / NOT silently moved)
- #1–#5, #11–#15, #26, #28, #30, #36–#42, #46–#50 remain PARTIAL/ROADMAP for future PKGs (not in the selected cluster; #11/#42/#48 not included to avoid padding / because they belong to already-covered or security/cost clusters).
- #6–#10 (Quality, PKG-14), #16–#20 (Optimization, PKG-16), #21–#25 (Security/Compliance, PKG-15), #27/#30 (Visual, PKG-13), #36–#40 (Team, PKG-11), #47 (Knowledge, PKG-12) already COMPLETED — not reopened.
- Payment architecture, PKG-13/14/15/16: not modified.
- **No real deployment execution, no shell execution, no provider pushes** — the deployment/rollback capabilities are advisory planning only (honest: no execution primitive is claimed).

## Deliverables
- `backend/src/modules/developer-workflow/` — `types.ts`, `security.ts`, `migrationAgent.ts` (#29), `docDrift.ts` (#34), `contextualDebug.ts` (#41), `hotspotProfiler.ts` (#44), `branchStrategy.ts` (#31), `rollbackPredictor.ts` (#32), `hotfix.ts` (#33), `featureFlagOrchestrator.ts` (#35), `healthDashboard.ts` (#43), `errorRunbook.ts` (#45), `service.ts`, `routes.ts`, `developer-workflow.test.ts`.
- Non-persisted (advisory, mirrors PKG-13/16) — **NO migration**.
- Wiring: `app.ts` mount `/api/v1/developer-workflow`; `ids.ts` new prefixes.
- Frontend: `DeveloperWorkflowPanel.tsx` + `.test.tsx` (capability-rails pattern).
- Docs: `docs/CODECONCLAVE_PKG17_GATE.md`.

## Security model
- All routes `requireAuth` + workspace/project ownership via existing per-project services and the isolated files service.
- Source intake reuses the quality-intelligence text-MIME allowlist + prompt-injection containment (mirrors PKG-15/16); binaries skipped, never executed.
- No workspace writes, no command execution, no provider calls; all outputs advisory with explicit truthfulness state.
- No secrets returned; reports aggregated/redacted.
