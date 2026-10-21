# yoto.txt spec vs. codebase: gap audit

Source: `C:\Users\sride\yoto.txt` (4,369 lines). It contains several overlapping specs (Gemini, Manus, ChatGPT and others). This audit uses the **Manus** spec (lines 135–491) as the canonical feature list because it is the most precise. The other specs repeat the same 40 Solo / 20 Team structure.

This is a first pass based on module evidence; a ✅ means a backing module/route/page exists, not that it was re-verified end to end on a paired device.

Legend: ✅ exists · 🟡 partial · ❌ missing · ⚠️ needs a product decision

## Done in this change

| Spec item | What was built |
|---|---|
| Plugins (Team: "Extensible Plugin Ecosystem SDK"; Solo #31 instructions & templates) | **Skill plugins**: `backend/src/modules/skillplugins/*`, migration `0150_skill_plugins.sql`, page `/skills` (sidebar **Plugins**). 13 built-in plugins (Architect, Coder, Security, Tester, Performance, Research, Docs, Reviewer, Planner, Debugger, Git & PRs, Release Checks, Team Handoff), install/enable/disable/uninstall, custom plugins from a JSON manifest, skills injected into chat (labelled, capped at 12k chars), slash commands expanded server-side and shown in the chat `/` menu. Data only; no code or hooks, so no privilege escalation. |
| Team-shared plugins (Team #4, #11) | Owners/admins publish a plugin to a team (`0151_team_skill_plugins.sql`); it's active for every active member, attributed in the skill block, with a full PUBLISHED/UNPUBLISHED version history and audit. Members can't change it. |
| Account export & deletion (Solo #36, Team #18) | `backend/src/modules/account/*`, `0152_account_deletion.sql`, Settings → **data** tab. Allowlisted JSON export (no hashes/secrets/embeddings). Deletion request with exact-email confirmation and a 30-day cancellable grace window, executed by the watchdog: revokes sessions/devices/API keys, scrubs personal (non-team) content, de-identifies the user, and stores a receipt with counts. Refused while the user owns a team that has other members. Available without a paid plan. |
| Org-wide execution policies (Team #14) | `0153_team_control_policies.sql`; `evaluatePolicy` now also applies the team's policies to tasks in team projects (strictest wins, only tightens). Owners/admins manage them from Control → Risk policies → "Applies to"; every change is audited at TEAM scope. |
| Icons | 11 new icons (compass, code, flask, gauge, book, eye, map, bug, git-branch, rocket, plug); every plugin has an icon tile; Connectors now uses `plug`, Plugins uses `puzzle`. |

## Solo (40)

| # | Feature | Status | Evidence / gap |
|---|---|---|---|
| 1 | Paid account & subscription | ✅ | `payments/*`, `entitlements`, `requireWorkspaceEntitlement` |
| 2 | BYOK for the one provider | ➖ | **Decided: keep platform AI** (no BYOK). The Manus BYOK requirement is intentionally not implemented. |
| 3 | Key lifecycle & privacy | ➖ | Not applicable without BYOK |
| 4 | AI request transparency | 🟡 | `usage/analytics.ts`, admin AI usage; per-request provider usage display to verify |
| 5 | Coworker task inbox | ✅ | `execution`, `WorkPage`, `CoworkerPage` |
| 6 | Plan-before-action | ✅ | `actions/planner.ts`, `actions/contract.ts` |
| 7 | Multi-step execution & progress | ✅ | `execution/orchestrator.ts`, worker + watchdog |
| 8 | Pause / cancel / stop-all | ✅ | `POST /api/v1/actions/stop-all` |
| 9 | Durable history & audit | ✅ | `history`, `audit` |
| 10 | Return-to-work continuity | ✅ | `returnToWork`, `MorningBrief` |
| 11 | Projects & workspace grants | ✅ | `projects`, `local-workspace` |
| 12–14 | File read / edit with diffs / create-rename | ✅ | `files`, `reviews/diff.ts`, local agent |
| 15–18 | Code mapping, generation, debugging, tests | ✅ | `copilot`, `codeworkspace`, `engineering` (+ Coder/Debugger/Tester plugins) |
| 19 | Controlled terminal | ✅ | `terminal`, `os/sandbox.ts` |
| 20 | Git status/diff/review | ✅ | `reviews`, `developer-workflow` |
| 21 | Build & test verification | ✅ | `verify` |
| 22 | Preview builds | ✅ | `preview` (gated by config) |
| 23–25 | Web research, managed browser, approved interaction | ✅ | `agent/browser*.ts`, `browser-policy.ts` |
| 26 | Downloads & artifacts | ✅ | `artifacts`, `downloads` |
| 27–28 | App opening / limited desktop actions | ✅ | `agent/desktop-policy.ts` |
| 29 | Voice input | ✅ | `voice` |
| 30 | Persistent project memory | ✅ | `memory`, `dna` |
| 31 | Personal instructions & templates | ✅ | **New:** custom skill plugins (skills = instructions, commands = templates) |
| 32 | Approvals & risk | ✅ | `ApprovalsPage`, `control/policies.ts`, auto-approval |
| 33 | Capability & permission center | ✅ | `access`, `ControlPage`, `RemotePage` |
| 34 | Failure reporting & retry | ✅ | `recovery/*`, watchdog retries |
| 35 | Account security & recovery | ✅ | `auth`, `MfaPage`, `RecoveryPage` |
| 36 | Data export & deletion | ✅ | **New:** full export + deletion request/cancel/receipt |
| 37 | Notifications | ✅ | `notifications`, `comms` |
| 38 | Per-task artifact bundle | ✅ | `artifacts` |
| 39 | Usage, quota & plan status | 🟡 | Plan status exists; provider-reported usage depends on #2 |
| 40 | Honest capability status & receipts | ✅ | `/health`, `receipts`, `proofOfWork.ts` |

## Team (20)

| # | Feature | Status | Evidence / gap |
|---|---|---|---|
| 1–3 | Org workspace, invitations/seats, RBAC | ✅ | `teams`, `TeamsPage`, `rbac_role` |
| 4 | Shared project context & instructions | ✅ | **New:** team-published skill plugins (skills), versioned |
| 5 | Shared task queue & assignment | ✅ | `teamcollab` |
| 6 | Team approvals & reviewer routing | 🟡 | Approvals exist; reviewer routing is thin |
| 7–8 | Device inventory, team grants | ✅ | `agent`, `access` |
| 9 | Team BYOK key | ➖ | Not applicable (platform AI) |
| 10 | Team usage transparency | 🟡 | Depends on #9 |
| 11 | Team templates & approved workflows | ✅ | **New:** team-published slash commands, versioned |
| 12 | Team knowledge base | ✅ | `knowledge` |
| 13 | Team audit log | ✅ | `audit` |
| 14 | Org-wide execution policies | ✅ | **New:** team control policies enforced on team-project tasks |
| 15 | Repo review & PR prep | ✅ | `reviews`, GitHub/GitLab connectors (+ Git & PR plugin) |
| 16 | Handoffs & review notes | 🟡 | Handoff code exists in places (+ Team Handoff plugin) |
| 17 | Notifications & escalation | ✅ | `notifications`, escalation logic |
| 18 | Data lifecycle & offboarding | 🟡 | Member removal + personal export/deletion done; whole-organization export not built |
| 19 | Reliability & observability | ✅ | `operations`, `/health`, watchdog |
| 20 | Policy-aware completion reports | ✅ | `receipts`, `proofOfWork.ts` |

## Remaining

- **Org-wide export** (Team #18): export of all team-owned records for owners.
- **Per-request provider/usage display** (Solo #4, #39; Team #10): verify against the existing `usage` analytics and surface per request.
- **Reviewer routing** (Team #6) and **handoff trail** (Team #16) are partial and need a focused pass.

## Verification

- Backend vitest: 4,459 passed; only `secret-scan.test.ts` fails, because it requires the checkout folder to be named `CodeConClave-` (environmental in a worktree). Frontend vitest: 644/644.
- All 151 migrations (incl. 0150–0153) applied on real Postgres (PGlite + pgvector + pg_trgm). End-to-end checks ran the real services as a non-superuser role so RLS was enforced: plugins & team plugins 20/20, account export/deletion 23/23, team policies 14/14.
- Not verified: a live browser walkthrough (needs a signed-in, paid session against a running database).
