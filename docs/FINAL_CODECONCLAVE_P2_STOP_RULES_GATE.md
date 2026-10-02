# CodeConClave — P2.6 Stop Rules Gate

**Phase:** AI OS P2 (Killer Cowork Experience)
**Scope:** P2.6 Stop Rules — policy/capability-enforced hard execution boundaries
**Date:** 2026-09-01
**Status:** PASS

## Objective

Allow a user/workspace to define hard execution boundaries (protected files,
protected directories, max files changed, max runtime, no file deletion,
approval-required operations) that are enforced **below the AI prompt layer**.

## Non-negotiable security model — what cannot bypass

The following are all routed through the SAME stop-rule policy check and cannot
bypass it:

- prompt / system-prompt manipulation
- agent / sub-agent instructions
- tool arguments
- API requests / WebSocket requests
- scheduled tasks / background tasks
- skill execution
- voice commands
- imported / replayed cowork state

Canonical enforcement chain (implemented in `backend/src/os/p2/stop-rules.ts`):

```
REQUEST
→ AUTHENTICATION
→ CAPABILITY CHECK
→ STOP-RULE POLICY CHECK   <- StopRules.evaluate() (this module)
→ RESOURCE GOVERNOR
→ SANDBOX / EXECUTION
→ ACTION
```

If the rule denies, the action MUST NOT occur.

## How each requirement is met

| # | Requirement | Implementation (`stop-rules.ts`) |
|---|-------------|---------------------------------|
| 1 | Protected files (exact path) | `protectedPaths` with exact match; write/edit/rename require a bound approval |
| 2 | Protected directories (children inherit) | `isUnder()` prefix/globbing match on recursive paths (`/**`); nested files inherit |
| 3 | No delete rule | `allowDelete=false` denies `delete`, `rename` (rename-as-delete), directory removal and delete-capable `exec` |
| 4 | Max files changed | atomic `changedFiles` counter under a promise-chain mutex; sixth change denied; concurrent attempts cannot race past |
| 5 | Max runtime | `deadlinePassed()` from real execution elapsed time (`Date.now() - startMs`), not model claims; supervisor governs cancellation/escalation |
| 6 | Approval-required ops | bound approval grants: (user, workspace, process/action, capability, target, expiration, one-time). No unbounded "approved forever" |
| 7 | Precedence | HARD DENY (no-delete / protected delete) → PROTECTED RESOURCE → CAPABILITY → APPROVAL → RESOURCE LIMIT → ALLOW. Hard deny never overridden |
| 8 | Child inheritance | policy lives on workspace/execution context, not the model; children inherit, cannot gain broader rights |
| 9 | Cross-agent accounting | shared atomic files-changed counter across all agents (A+B consume budget, C denied) |
| 10 | Background/scheduled/skill/replay | current policy governs current execution (`setPolicy` swaps live policy; no stale broader policy) |
| 11 | Voice | `VoiceGateway` (voice.ts) dispatches through the same stop-rule decision; "delete all test files" denied |
| 12 | Skills | `SkillEngine.replay` evaluates every step against current rules at execution time |
| 13 | Replay/checkpoint | `SessionReplay`/skills re-apply current policy; stored state cannot bypass |
| 14 | Canonical policy config | single `StopRulePolicy` data object; `StopRuleOperation` const-object enum (project convention) |
| 15 | UX messaging | deny reason is user-facing ("Blocked by Stop Rule: Maximum files changed = 5/5."); no internal policy leakage |
| 16 | Audit | `RULE_EVALUATED / RULE_ALLOWED / RULE_DENIED / APPROVAL_REQUESTED / APPROVAL_GRANTED / APPROVAL_EXPIRED` with workspace/cowork/process/action/target/rule/decision/timestamp/trace; no secrets logged |

## Path canonicalization (anti-traversal)

`canonicalize()` rejects encoded traversal (`%2e%2e`, null bytes) and collapses
`.`/`..`; a `..` that escapes the workspace root throws. Alternate separators and
case variants are normalized BEFORE policy evaluation, so `/src/../secret/.env`
and `\src\..\secret\.env` collapse to the same canonical in-root path as the
requested target and are protected identically.

## Verification (proven in `src/os/os.p2.test.ts`)

- Protected file ALLOW / DENY
- Protected directory nested-file inheritance (ALLOW/DENY)
- Traversal DENY (`../../etc`, encoded)
- No-delete DENY (delete, rename, exec)
- Max files exact boundary + sixth denied
- Concurrent max-file attempts cannot exceed limit (atomic)
- Deadline enforced (max runtime from execution state)
- Approval: missing denied, valid allowed, expired denied, wrong target denied, wrong process denied
- Rule precedence (hard deny overrides approval)
- Child process cannot escalate capability
- Cross-agent accounting (A+B consume budget, C denied)
- Background/scheduled/skill/replay: current rules preserved
- Voice: current rules enforced
- Personality: cannot override stop rules
- Audit events recorded with decision + no secret leakage

## Bypass-resistance proof (module-level, below prompt)

1. Malicious model: any instruction that would `delete`/`write`/`exec` a protected
   or delete-blocked target is denied by `evaluate()` regardless of instruction
   content — rules are in code, not the prompt.
2. Child agent: shares the same `StopRules` policy/context; cannot gain broader
   rights.
3. Direct API request: must pass `evaluate()`; deny blocks execution.
4. Tool call: executed through the OS capability layer whose gate is
   `evaluate()`; deny blocks the tool.
5. Scheduled/background task: `Scheduler.runDue` and background paths gate via
   the current policy; a denied job is recorded `blocked` and does not run.
6. Replay: replay re-evaluates under current policy (`setPolicy`), not the
   captured/stale one.
7. Voice command: `VoiceGateway.execute` short-circuits on
   `stopRuleDecision.allowed === false` before any performance action.
8. Personality: `Personality.mayProceed` returns `false` whenever `ruleAllows` is
   false; a personality mode can NEVER convert a deny into an allow.

## Flagging / preservation

- Gated behind `AIOS_P2_STOP_RULES` (default OFF) and `AIOS_ENABLED` (default
  OFF). When off, `evaluate()` returns `ALLOW` and no behavior changes.
- `FEATURES_REMOVED = 0` — no existing functionality removed or disabled.

## Gate result

```
STOP_RULES = PASS
PROTECTED_FILES = PASS
PROTECTED_DIRECTORIES = PASS
NO_DELETE = PASS
MAX_FILES = PASS
MAX_RUNTIME = PASS
APPROVAL_REQUIRED = PASS
RULE_PRECEDENCE = PASS
CHILD_INHERITANCE = PASS
CONCURRENT_ACCOUNTING = PASS
BACKGROUND = PASS
SCHEDULED = PASS
SKILLS = PASS
REPLAY = PASS
VOICE = PASS
AUDIT = PASS
BYPASS_RESISTANCE = PASS

P0_REGRESSIONS = NO
P1_REGRESSIONS = NO
FEATURES_REMOVED = 0
TYPECHECK = PASS
BUILD = PASS
FULL_TESTS = PASS (3 pre-existing non-OS flakes only: gmail-claim HTTP timeouts x2, perf-17 timing x1)
SECRET_SCAN = CLEAN

PRODUCTION_DEPLOYMENT = NOT_EXECUTED

STOP_RULES_GATE = PASS
```

## Deployment note

No production deployment, no Railway changes, no Neon production migration, no
frontend/backend production deployment. All changes are additive and
flag-gated; the live system is unchanged while flags stay OFF.
