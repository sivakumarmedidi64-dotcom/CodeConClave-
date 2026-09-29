# CodeConClave — PKG-21 — Deployment History + Rollback + Release Evidence — Scope & Audit

**Package:** PKG-21 (CodeConClave PRO)
**Theme:** DEPLOYMENT HISTORY + ROLLBACK + RELEASE EVIDENCE
**Status:** SCOPE LOCKED
**Canonical registry:** `docs/CODECONCLAVE_FINAL_MASTER_FEATURE_REGISTRY.md`

PKG-21 builds a **reliable deployment-history and rollback layer** on top of the
existing deployment / runtime (PKG-19) / environment (PKG-20) systems. It is
**additive** — it does NOT reopen payment architecture, does NOT rebuild PKG-19
runtime execution, does NOT rebuild PKG-20 environment management, does NOT build
a second deployment architecture, does NOT fake real provider rollback, and does
NOT start PKG-22.

---

## 1. Registry coverage — exact IDs (NOT invented)

PKG-21 does **not** invent registry IDs. There is **no dedicated registry ID for
"Deployment History"**, "Release Evidence", or "controlled rollback execution";
those concerns were absent from the canonical registry (the deploy/rollback
capabilities agreed so far are advisory or from the V4E wizard). PKG-21 therefore
**reuses the existing anchors** and adds the missing persistent layer as a NEW
(registed, additive) capability composed on them.

| Registry ID | Capability | Current Status | Existing Foundation | Gap | Required Work | Runtime Status |
|-------------|------------|----------------|---------------------|-----|---------------|----------------|
| #32 Rollback Predictor | advisory readiness/risk scoring | COMPLETED (PKG-17 `developer-workflow/rollbackPredictor.ts`) | advisory planner | no controlled execution, no history | consumed into rollback preflight evidence (advisory) | reused (unchanged) |
| #33 Hotfix Fast-Track | minimal hotfix steps w/ containment/rollback | COMPLETED (PKG-17 `developer-workflow/hotfix.ts`) | advisory | no release-record link | linked as failure-correlation evidence | reused (unchanged) |
| Group A — Audit Trail | immutable audit log | LIVE (`modules/audit`) | `recordAudit` | — | every deployment/rollback writes an audit event | reused (unchanged) |
| Group A — Terminal | interactive terminal | LIVE (PKG-19 runtime + PKG-20 panel) | `RuntimeExecutionsEngine` | no deployment history | deployment history volume independent | reused (unchanged) |
| deployment-wizard (V4E) | discovery / readiness / plan / strategy / approval / pre-deploy / post-deploy-verify / rollback-planner / report | COMPLETED (module, 26 tests) | `modules/deployment-wizard/*` | no immutable deployment record, no execution rollback, no history view | PKG-21 builds a release-history + rollback layer ON TOP (does not rewrite wizard) | reused (unchanged) |
| **NEW — Release history & rollback** | immutable deployment records, release identity, verification evidence, controlled rollback, release diff, failure correlation, provider capability | NEW | none (absent from registry) | add persistent release/rollback layer | new `modules/release/*` + migration | **implementation status below** |

**Registry ID aggregation for the final gate:**
- `REGISTRY_IDS_COMPLETED` = `#32 Rollback Predictor` (reused), `#33 Hotfix Fast-Track` (reused), `Release History & Rollback` (NEW implemented)
- `REGISTRY_IDS_PARTIAL` = `none`
- `REGISTRY_IDS_BLOCKED` = `none`
- `REGISTRY_IDS_NOT_IMPLEMENTED` = `none` (real provider execution is ENVIRONMENT_BLOCKED, not "not implemented" — the controlled-rollback layer works, but no live provider is reachable)

---

## 2. Existing deployment foundation audit (Phase 2)

Reused infrastructure (verified in source):

| Concern | Exists? | Source | Reused / New |
|---|---|---|---|
| Deployment planning | YES | `deployment-wizard/deploymentPlan.ts` | REUSED |
| Deployment state machine (advisory) | YES | `deploymentStrategy.ts` (standard/rollback/preview/canary) | REUSED (advisory, honest) |
| Provider abstraction (advisory) | PARTIAL | `deploymentPlan.ts` `detectTargetService`, `deploymentStrategy.ts` supportedProviders | REUSED concept; PKG-21 adds HONEST capability states |
| Deployment approvals | YES | `deployment-wizard/humanApproval.ts` | REUSED |
| Pre-deploy readiness | YES | `deployment-wizard/preDeployCheck.ts` | REUSED |
| Post-deploy verification (health/smoke) | YES | `deployment-wizard/postDeployVerify.ts` | REUSED as verification GATES |
| Rollback planning (advisory) | YES | `deployment-wizard/rollbackPlanner.ts` | REUSED (advisory feasibility only) |
| Deployment reports | YES | `deployment-wizard/deploymentReport.ts` | REUSED |
| Immutable deployment record | NO | — | NEW (PKG-21) |
| Deployment history view/API | NO | — | NEW (PKG-21) |
| Release identity / version / commit association | PARTIAL | plan metadata targetCommit/previousCommit | NEW persisted release identity (PKG-21) |
| Controlled rollback execution | NO | rollbackPlanner is advisory-only; no execution | NEW (PKG-21, honest) |
| DB rollback compatibility guard | NO | — | NEW (PKG-21) |
| Failure correlation | PARTIAL | errorRunbook (#45), autopsy, runbooks | NEW deterministic deployment-failure correlation (PKG-21) |
| Release diff / change summary | NO | — | NEW (PKG-21, evidence-based, no invented metrics) |
| Deployment logs | PARTIAL | runtime execution history | Wired as evidence |
| Environment awareness | YES | PKG-20 `modules/environment` (DEV/STAGING/PROD) | REUSED |
| Deployment permissions | YES | `requireAuth` + `assertProjectAccess` (owner-scoped) | REUSED |

> No duplicate deployment records are created: PKG-21 introduces **one new
> immutable `deployments` record** (release identity + evidence + status) and
> **one `rollback_runs` ledger** (every rollback attempt). It extends the existing
> `deployment-wizard` records by REFERENCE (`profileId`, `planId`, `verifyId`),
> never by rebuilding them.

---

## 3. Deployment record model (Phase 3)

New persistent, immutable `deployments` record representing:

- `deployment_id` (immutable, prefixed `DEPLOYMENT 'dp'` — stable identity, never silently re-issued)
- project, workspace, environment, provider
- service/component, version, commit SHA (where available; `GIT_VERSION = UNAVAILABLE` when absent)
- deployment status (state machine), started_at, completed_at, duration
- build result / test result / health result / smoke result / verification status
- deployment URL (only where safe) + provider deployment ID (where available)
- failure reason, rollback availability
- predecessor deployment, rollback source/target

Do **not** store secrets. Do **not** store unnecessary private request data.

---

## 4. Deployment history (Phase 4)

- Chronological, per-project, workspace-isolated, environment/status/service-filterable
- Each record traceable to: code version + environment + deployment result + verification evidence
- Details view + failure details + verification evidence

---

## 5. Release identity (Phase 5)

- Stable immutable `deployment_id`
- Where Git info is provided: branch, commit SHA (never fabricated), commit timestamp, author (where appropriate)
- When Git info is unavailable: `GIT_VERSION = UNAVAILABLE` (honest, no fabricated hashes)

---

## 6. Rollback engine + 7. safety + 8. DB safety (Phases 6–8)

Rollback flow: USER REQUEST → AUTHORIZATION → SELECT VERIFIED PREVIOUS RELEASE →
PREFLIGHT (10 safety checks) → PROVIDER CHECK → EXECUTE (honest; provider-gated) →
HEALTH/SMOKE RE-VERIFY → VERIFY → ROLLBACK SUCCESS / FAILURE.

- Never deletes production data automatically.
- Application rollback and DB migration rollback are separate concerns.
- DB compatibility assessed; destructive/non-backward-compatible DB rollback → `BLOCKED`.
- Unknown provider semantics → `ROLLBACK = BLOCKED` (never fake success).
- Duplicate-rollback protection; every attempt recorded in `rollback_runs` + audit.

---

## 9. Release diff / change summary (Phase 9)

Evidence-based: files changed, commits, lines added/removed, relevant quality /
security / optimization findings, test changes. Reuses real intelligence outputs.
**No invented impact metrics.**

---

## 10. Failure explanation (Phase 10)

Correlate deployment → build/tests/runtime/health/smoke/environment/code changes.
Return: failed stage, evidence, likely cause (deterministic), affected service,
relevant version/commit, recommended next action, rollback availability.
**No fake root causes.**

---

## 11. Deployment verification (Phase 11)

Status values: PLANNED / STARTED / BUILDING / TESTING / DEPLOYING / VERIFYING /
VERIFIED / FAILED / PARTIAL / ROLLED_BACK / ROLLBACK_FAILED / BLOCKED.

**Only `VERIFIED` means all configured verification gates passed.** A provider
accepting a request is NEVER treated as success on its own.

---

## 12. Real provider abstraction (Phase 12)

Provider capability states: `SUPPORTED / CONFIGURED / UNCONFIGURED /
ENVIRONMENT_BLOCKED / UNAVAILABLE / UNSUPPORTED`. Adapter existence ≠ integration.
Because no live provider/runtime target is reachable from the test environment,
the real-provider execution is reported `ENVIRONMENT_BLOCKED` (honest). Simulated
rollback is never reported VERIFIED.

---

## 13–14. Frontend + API (Phases 13–14)

Frontend: `DeploymentHistoryPanel` (version/commit/environment/provider/status/
health/smoke/verification/rollback availability) with production rollback
requiring explicit confirmation. API: `GET /history`, `GET /details`,
`GET /release-diff`, `POST /rollback`, `GET /rollback-status`, `GET /verification`,
`GET /providers` — all authenticated + project-owned + validated + safe errors,
**never exposing credentials**.

---

## 15. Testing

27 cases (enumerated in the prompt) via Vitest, deterministic fake-DB harness
(no network) — `NO_TESTS_WEAKENED = TRUE`, `--maxWorkers 2`.

---

## 16–18. Regression & payment

Order per prompt; baselines: backend 2446 passed / 3 skipped / 1 documented
pre-existing timing flake; frontend 355 passed / 1 documented pre-existing
ReviewListPage failure. `PAYMENT_REGRESSION` must PASS or STOP.

---

## 19. Honest rollback status

Reported at finalization: `REAL_PROVIDER_DEPLOYMENT`, `REAL_PROVIDER_ROLLBACK`,
`APPLICATION_ROLLBACK`, `DATABASE_ROLLBACK`, `DEPLOYMENT_VERIFICATION` — no
simulated rollback is ever called VERIFIED.

---

## 20. Deliverables

- `docs/PKG21_SCOPE_AND_AUDIT.md` (this document)
- `database/migrations/0063_release_history_rollback.sql`
- `backend/src/modules/release/*` (new module)
- `backend/src/modules/release/release.test.ts` (27 cases)
- `frontend/src/components/DeploymentHistoryPanel.tsx` + tests
- `docs/CODECONCLAVE_PKG21_GATE.md`
