# CodeConClave — PKG-20 — Integrated Terminal + Environment Safety — SCOPE AND AUDIT

**Package:** PKG-20 (CodeConClave PRO, GROUP C live-runtime expansion)
**Derived from:** `docs/CODECONCLAVE_FINAL_MASTER_FEATURE_REGISTRY.md` against actual repo state.
**Previous foundation:** PKG-19 Runtime Development (F34/F90/F38/F49) — REUSED, NOT rebuilt.

---

## 1. Theme & mission

**INTEGRATED TERMINAL + ENVIRONMENT SAFETY.** Make CodeConClave's terminal and
execution environment feel like a real development workspace while keeping
execution safe:

```
USER → COMMAND → VALIDATE → EXECUTE → STREAM → OBSERVE → STOP/COMPLETE → PERSIST RESULT
PROJECT → DEVELOPMENT/STAGING/PRODUCTION → DETECT CONFIG → VALIDATE REQUIRED VARS → PROTECT SECRETS → RUN SAFELY
```

It must be **difficult to accidentally run a destructive command against the
wrong environment**. No second execution engine, no second process manager, no
second background/event bus — everything extends the existing PKG-19 runtime,
the deterministic policy engine (`modules/execution/policy.ts`) and the existing
secret-guard redaction (`modules/secretGuard/service.ts`).

---

## 2. Phase 1 — EXACT canonical scope & registry mapping

Audit note: the canonical registry is **named‑feature based** (it does not use
F‑codes in the text); the F34/F90/F38/F49 codes used by PKG-19 are the internal
runtime anchors established in the PRIOR gates. PKG-20 anchors to the **canonical
named registry entries** that the Integrated‑Terminal + Environment‑Safety theme
completes, and reuses their existing foundations — it invents no new IDs.

| Registry ID | Capability | Current Status | Existing Foundation | Gap | Required Work | Runtime Status |
|---|---|---|---|---|---|---|
| Terminal (Group A core) | Integrated Terminal | LIVE (agent-relay `modules/terminal`) | `modules/terminal/{routes,service,store}` + PKG-19 `runtime` engine + `RuntimeWorkspacePanel` | No server-side integrated terminal UX, no env context, no command-safety preflight, no history with env/cwd | `Environment` module + Integrated Terminal frontend on the PKG-19 runtime engine | COMPLETED (sandbox-gated) |
| Terminal Export (Group B) | Terminal surface completion | PARTIAL | `modules/terminal` | Export/history of terminal runs with env/cwd metadata | Command history persisted with `environment` + `cwd` (extend `runtime_executions`) | COMPLETED |
| Sandbox (Group G AI OS) | PolicySandbox execution safety | FLAGGED | `os/sandbox.ts` `PolicySandboxExecutor` (deny-by-default, allow-list, SIGTERM→SIGKILL, 512KB cap) | Reuse only — no rebuild | Used unchanged by terminal preflight/execution | REUSED (no change) |
| Secret Management (Group G AI OS / Secret Guard) | Secret leak protection | LIVE | `modules/secretGuard/service.ts` (`redactSecrets`, `scanContentForSecrets`) + PKG-19 `runtime/security.ts` (`redactOutput`, `redactUrl`) | Reuse + a new secret/leak-protection harness for every terminal stage + env validation (names-only) | Secret protection applied at command display, stdout, stderr, history, logs, SSE, audit, messages; env validation reports names-only | COMPLETED |
| Audit Trail (Group A) | Auditable actions | LIVE | `modules/audit/service.ts` (`recordAudit`, `AuditAction`) | Environment switches not persisted/audited; terminal safety actions not audited | `environment_state` + `environment_switches` persistence + audit on switch and on CAUTION/DANGEROUS confirmation | COMPLETED |
| Process Supervision / Process Manager (Group G AI OS) | Background task lifecycle | FLAGGED | PKG-19 `modules/runtime/background.ts` (STARTING→RUNNING→…→BLOCKED) + events | Reuse only — no second scheduler | Integrated Terminal + environment preflight drive/observe existing background engine | REUSED (no change) |

**New additive capability (no registry row, part of "Terminal" completion):**
Environment awareness — `DEVELOPMENT / STAGING / PRODUCTION` per project,
detection, required-variable validation (names-only), command↔environment
cross-check, auditable switching. This is the "Environment Safety" half of the
theme and is genuinely absent from the repo (no DEV/STAGING/PROD concept exists).

---

## 3. Architecture

- **Backend `modules/environment/`** (new):
  - `types.ts` — `Environment` enum, env-var statuses, `PreflightResult`, risk tiers.
  - `validator.ts` — detect/enumerate required environment variables by name and
    report `PRESENT / MISSING / INVALID / NOT_REQUIRED / UNVERIFIED` — **never
    values**.
  - `safety.ts` — command risk `SAFE / CAUTION / DANGEROUS / BLOCKED` composing
    the existing `riskOfCommand`/`dangerousCommand`/`evaluateCommand`
    (deterministic), plus environment×command cross-check
    (`PRODUCTION + DANGEROUS → confirmation_required`, `DEV + PROD-only deploy →
    block/confirm`, unmatched DB target → block).
  - `sessions.ts` — per-project active environment, persisted to
    `environment_state`; auditable switch via `environment_switches` + `recordAudit`.
  - `service.ts` — `getEnvironmentStatus`, `validateEnvironment`,
    `selectEnvironment`, `preflightCommand`.
  - `routes.ts` — authenticated `/api/v1/environment/*`.
- **Migration `0002_...`** naming is established per-package; PKG-20 uses the next
  migration number after 0061 (0062_runtime_environment_safety.sql):
  - `ALTER TABLE runtime_executions ADD COLUMN environment text, ADD COLUMN cwd text`
    (extend existing history, no new execution engine).
  - `CREATE TABLE environment_state` (project_id PK, environment, updated_at).
  - `CREATE TABLE environment_switches` (audit: from_env, to_env, reason, actor, ts).
- **Frontend `IntegratedTerminalPanel.tsx`** + test — real terminal UX on the
  PKG-19 runtime + new environment endpoints (env indicator, cwd, streaming,
  exit code, state, duration, cancel, clear, rerun, history, PRODUCTION guard).

---

## 4. Security model (Phase 4)

All endpoints authenticated (`requireAuth`), project ownership
(`assertProjectAccess`), input validation, safe errors, auditability. Command
execution remains **deny-by-default** via the policy sandbox allow-list; the
terminal adds a **command-safety layer** (SAFE/CAUTION/DANGEROUS/BLOCKED) that
never silently executes a CAUTION/DANGEROUS command, requires explicit
confirmation, and BLOCKs platform-banned commands. Production context surfaces a
strong guard and blocks destructive DB commands by default. Secrets are redacted
at every stage and env validation returns names-only.

---

## 5. Deliverables

Phase 1 `docs/PKG20_SCOPE_AND_AUDIT.md` (this file), Phase 19
`docs/CODECONCLAVE_PKG20_GATE.md`, migration 0062, `backend/src/modules/environment/*`,
`runtime_executions` env/cwd columns + history search/filter/clear, `ids.ts`
+ `env.ts` additions, `IntegratedTerminalPanel.tsx` + test, PKG-20 backend test
(Phase 14: 24 security cases).

---

## 6. Testing plan (Phase 14/15)

- PKG-20 backend tests: env detection/validation, command risk tiers
  (SAFE/CAUTION/DANGEROUS/BLOCKED), production cross-check, secret redaction at
  every stage (stdout/stderr/history/logs/messages), names-only env APIs,
  cross-user + cross-workspace isolation, background ownership, cancellation,
  timeout, history ownership, malformed inputs, command injection, unsafe cwd,
  audited switch. Regression: PKG-20 + PKG-19(20) + runtime + payment +
  PKG-13/14/15/16/17 + full backend + full frontend + typecheck + build on both.

## 7. Honest limitations

- Execution still uses the **restricted sandbox abstraction** (`PolicySandboxExecutor`
  with an allow-list) — this is documented, not claimed as an unrestricted real shell.
- Command-risk classification is **heuristic/deterministic** — never claimed perfect.
- Environment variable state is `PRESENT/MISSING/INVALID/NOT_REQUIRED/UNVERIFIED`
  by name only; **secret contents are never exposed**.
- `REAL_EXTERNAL_RUNTIME_STATUS` remains `ENVIRONMENT_BLOCKED` (no live dev
  server/production target in the test environment); nothing is faked as live.
- Per the strict rule, **no `POST /reveal-secret`** endpoint is created.
