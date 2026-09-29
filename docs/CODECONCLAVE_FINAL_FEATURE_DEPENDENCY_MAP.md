# CODECONCLAVE — FINAL FEATURE DEPENDENCY MAP

**Read-only consolidation.** Shows how CodeConClave's subsystems stack. This is
the **single** dependency structure (P0–P3 flags default OFF; when OFF all OS
adapters fall back to existing behavior).

---

## 1. The dependency stack

```
AI OS  (backend/src/os/, P0-P3, FLAGGED OFF)
   │  security/capabilities/policies/audit
   ▼
Cowork Runtime  (modules: conversations, coworker-mode, activity, workspace)
   ▼
Agents / Processes / Skills / Tasks
   │  (modules/agents, agent, os/dag, os/supervisor, os/p2/skills, modules/tasks)
   ▼
Intelligence  (engineering/security/production/development intelligence, 50 features)
   ▼
Team / Voice / Scheduling / Background
   │  (modules/teams, os/p2/voice, os/p2/scheduler, os/p2/team-cowork)
   ▼
Web / Desktop / Mobile / IDE
   │  (frontend; desktop=NOT_READY; mobile=ROADMAP; IDE adapter=flagged)
   ▼
External Integrations  (github/slack/jira/ide adapters, integrations module)

┌───────────────────────────────────────────────────────────────┐
│ Payment / Entitlement  (separate trust subsystem)             │
│   linked to IDENTITY (auth) only — NOT to the feature stack.  │
│   static links → orchestrator → gmail watchdog → evidence →   │
│   intent → entitlement (single ACTIVE gate)                   │
└───────────────────────────────────────────────────────────────┘
```

**Key rule:** Payment/Entitlement is a separate trust subsystem connected to
**identity**, not to the product feature graph. This preserves the fail-closed,
no-cross-user guarantee.

---

## 2. Edge / dependency notes (honest)

- **Identity edge:** `Payment → Identity (auth)` is the only cross edge from the
  trust subsystem into the main graph. No other subsystem may mint entitlements.
- **Desktop** depends on the `local-agent` workspace (already exists) plus a not-yet-
  existing desktop shell → `DESKTOP = NOT_READY`.
- **AI OS execution** depends on `os/sandbox.ts` (PolicySandbox, additive; NOT
  container). Real container isolation + distributed execution are ROADMAP and do
  not gate any LIVE feature.
- **Intelligence** depends on the Cowork Runtime + memory/state; nothing in the
  LIVE core depends on Intelligence.
- **Voice / Scheduling / Team / Background** depend on the AI OS scheduler which
  in turn **reuses** the existing core recurrence engine (no duplicate scheduler).

## 3. Flag/activation surface (nothing on by default for new behavior)

- `AIOS_ENABLED / AIOS_*` (P0–P1) — default OFF.
- `AIOS_P2_*` (P2 cowork/skill/voice) — default OFF.
- `AIOS_GIT_ENABLED`, `AIOS_IPC_DURABLE`, `AIOS_BACKOFF_BASE_MS`, `AIOS_MAX_RESTARTS` — default OFF.
- `AIOS_PAYMENT_SELF_SERVICE` — default OFF (BUILT_INERT).
- `RAZORPAY_MODE = api|webhook` — OFF in the no-API/no-webhook config.

## 4. No change

No production change, no source change, no DB change, no deployment, no new
features. `FEATURES_REMOVED = 0`.
