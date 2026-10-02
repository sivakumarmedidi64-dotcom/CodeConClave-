# PHASE 4B REPORT — Local Agent, Terminal Integration, Remote Control, Screenshot Privacy

## Status
COMPLETE. Local-agent pairing and connection are fully implemented and tested; the terminal integration is wired end-to-end over the real process foundation (no fake output, no simulated pids); remote control runs through explicit expiring sessions; the screenshot privacy contract is implemented with an honest typed adapter (no simulated images); the frontend Terminal/Remote workspaces are wired to the real REST surface. PostgreSQL runtime is NOT available in this environment — migration 0024 is written and statically validated only, never executed (see PostgreSQL runtime).

## Files created
- `shared/src/contracts-phase4b.test.ts` — Phase 4B contract tests (12).
- `database/migrations/0024_phase4b_terminal_remote.sql` — terminal_sessions, terminal_history, remote_sessions (+ RLS, indexes, expire helper).
- `backend/src/modules/agent/service.ts` — presence derivation, device status, pairing/remote-session authorization helpers.
- `backend/src/modules/agent/screenshot.ts` — screenshot privacy contract, typed adapter, authorization gate.
- `backend/src/modules/terminal/store.ts`, `backend/src/modules/terminal/service.ts`, `backend/src/modules/terminal/routes.ts` — terminal module.
- `backend/src/modules/remote/service.ts`, `backend/src/modules/remote/routes.ts` — remote-control module.
- `backend/src/foundation/pairing.test.ts` (9), `backend/src/foundation/agent-status.test.ts` (6), `backend/src/foundation/terminal.test.ts` (13), `backend/src/foundation/remote.test.ts` (10), `backend/src/foundation/screenshot-privacy.test.ts` (9) — 47 new backend tests.
- `frontend/src/pages/TerminalPage.tsx` (rewritten), `frontend/src/pages/RemotePage.tsx` (rewritten), `frontend/src/pages/TerminalPage.test.tsx` (4), `frontend/src/pages/RemotePage.test.tsx` (4).

## Files modified
- `shared/src/constants.ts` — TerminalState/TerminalShell/RemoteSessionState/DevicePresence, AuditAction additions, Timeouts additions (PAIRING_CODE_TTL_MS 10 min, MAX_PAIRED_DEVICES 3, MAX_TERMINAL_TABS 8, TERMINAL_TIMEOUT_MIN/MAX_MS, AGENT_HEARTBEAT_INTERVAL_MS 30s, AGENT_PRESENCE_STALE_MS 90s, REMOTE_SESSION_TTL_MS 8h, REMOTE_SCREENSHOT_AUTH_TTL_MS 15 min).
- `shared/src/contracts.ts` — pairingCodeSchema, terminalCreateSchema, terminalInputSchema, terminalListQuerySchema, terminalSearchQuerySchema, remoteSessionCreateSchema + input types.
- `backend/src/modules/auth/service.ts` — verifyDevicePairing storage-format parse fix; revokeDevice drops the live agent socket immediately.
- `backend/src/modules/agent/ws.ts` — heartbeat CHECK-violation fix (last_seen_at only), capability grants on connect (revoked on disconnect/revocation), cmd_stream persistence, disconnectDevice.
- `backend/src/modules/agent/browser.ts` — policy gates + active-remote-session requirement on every relayed action.
- `backend/src/modules/agent/routes.ts` — GET /status returns presence-aware device status.
- `backend/src/shared/ids.ts` — prefixes tsm / thl / rms.
- `backend/src/app.ts` — mounts /api/v1/terminal and /api/v1/remote.
- `local-agent/src/terminal.ts` — full state machine (PLANNED/STARTING/RUNNING/COMPLETED/FAILED/KILLED/TIMED_OUT), pid evidence, timeout kill.
- `local-agent/src/policy.ts` — gateTerminalInput + BUILTIN_OR_CMDLET allowlist.
- `local-agent/src/index.ts` — terminal.start/input gating, shell/timeout clamping, tabId in cmd_stream, pid in status stream.
- `local-agent/src/foundation/terminal.test.ts` — assertions aligned to the frozen state machine; 4 new Phase 4B tests.
- `frontend/src/lib/types.ts` — DeviceInfo enrichment (presence/remoteCapable/capabilities), TerminalSessionInfo, TerminalHistoryLine, RemoteSessionInfo.

## Database migrations
`0024_phase4b_terminal_remote.sql` (new) — static validation only, never executed (no PostgreSQL runtime). Contains terminal_sessions (7-state CHECK, pid, partial unique index on live sessions per device+tab), terminal_history (channel CHECK, seq, GIN index), remote_sessions (ACTIVE/EXPIRED/REVOKED CHECK, 8h expires_at, screenshot_authorized + 15-min auth expiry, revoked_at), expire_remote_sessions() helper, RLS on all three tables. Migrations 0021–0024 remain unapplied.

## Pairing
6-digit code, 10-minute expiry embedded in the scrypt hash (`scrypt$v1$salt$hash$exp`), hashed-only storage (raw code never persisted), 5-attempt cap, 3-device maximum, PENDING_PAIRING → PAIRED on success, REVOKED on revocation with session cascade. **Fixed a real parse bug**: the stored hash was split into 5 segments but `slice(1)` was used, so every code was rejected as invalid; the corrected parse (`parts[0..3].join('$')` + `Number(parts[4])` expiry) was empirically validated. **Fixed a real DB bug**: the agent heartbeat set `state='ACTIVE'`, violating the `devices.state` CHECK constraint — heartbeats now update `last_seen_at` only.

## Agent
Token-authenticated WebSocket with 30s heartbeats; presence is derived, never guessed (ONLINE only from a live socket, STALE within 90s of last heartbeat, OFFLINE otherwise). On connect the hub registers owner-scoped capability grants (READ/WRITE_WORKSPACE, EXECUTE_COMMAND, 30-day TTL) and audits AGENT_CONNECTED; disconnect/revocation revokes grants and audits. Revoking a device now drops its live socket immediately (4403) — no waiting for the next heartbeat.

## Terminal
Real process foundation: RUNNING only ever mirrors agent-reported events with a real pid; PLANNED/STARTING transitions dispatch `terminal.start` to the paired device over the hub. Every dispatch and every interactive input line passes the deterministic policy engine first; the interactive relay is limited to LOW-risk commands — MEDIUM/HIGH input returns `approval_required` (must go through task approvals; never bypassed). Timeout is clamped to the spec range (1s–24h) and enforced by the agent (SIGTERM, then SIGKILL). Output is persisted per session (bounded lines) and searchable; logs are downloadable. The page polls the persisted session while active (the authenticated /agent-browser push stream is wired server-side).

## Remote Control
Explicit 8-hour remote sessions per device (idempotent reuse), immediate revocation (state REVOKED, clears screenshot authorization, audits), REST surface for list/create/revoke/status with presence.

## Frontend
TerminalPage: device select (presence shown), remote-session precondition, terminal session create, live output/status polling with real pid, input with honest policy-denial surfacing, kill/restart/logs, history search. RemotePage: pairing, presence pills (ONLINE/STALE/OFFLINE), remote session start/refresh/revoke, screenshot authorization (15 min), honest screenshot attempt. Both pages show explicit honesty messaging; no fake output or simulated images anywhere.

## Security
All terminal/remote actions require: paired device → online agent → ACTIVE remote session → policy-engine decision (capability grants registered on real connect only). Screenshots additionally require an explicit fresh 15-minute grant; never delivered after revocation; never persisted by the cloud; sensitive-region masking contract defined (byte-level masking needs a decoding adapter). Remote sessions and pairing codes are expiring. Tests assert no bypass: dangerous input and approval-required input never reach the device socket.

## Tests
| Workspace | Total | Passed | Failed |
|---|---|---|---|
| shared | 34 | 34 | 0 |
| local-agent | 49 | 49 | 0 |
| backend | 303 | 303 | 0 |
| frontend | 44 | 44 | 0 |
| **Total** | **430** | **430** | **0** |

## Typecheck
All four workspaces pass (`tsc --noEmit`): shared, local-agent, backend, frontend.

## Build
shared and backend build cleanly. (Frontend has no build script; local-agent none.)

## PostgreSQL runtime
NOT AVAILABLE — no .env, no Docker daemon, no postgres client in this environment. Migration 0024 (and 0021–0023) are written and statically validated but never executed; RLS/CHECK/function behavior at runtime is unverified. This is an infrastructure blocker, reported honestly — no migration success is claimed.

## External blockers
1. PostgreSQL runtime unavailable (above) — migrations cannot be applied or runtime-tested.
2. Real screenshot capture is an external limitation (server has no desktop session) — the typed adapter is wired and honestly returns unavailable (501 `screenshot_source_unavailable`); nothing is simulated.
3. LOCAL/HYBRID task dispatch: local tasks remain `WAITING_FOR_LOCAL_AGENT` — no dispatcher exists (honest gap, no fake dispatch).
4. No lint scripts exist in any workspace (root lint is a no-op) — reported, not silently claimed.
5. Two real bugs found and fixed this phase (pairing hash parse, heartbeat CHECK violation) and one data-mapping bug caught by tests (screenshot session row snake→camel mapping).

## Next phase
Approvals — full task-approval flows (create/approve/reject/expire/revoke, approval policy integration for MEDIUM/HIGH/CRITICAL, audit + notification wiring), plus optionally the LOCAL dispatcher, the browser WS push stream on the frontend, and a real screenshot adapter if a capture platform becomes available.