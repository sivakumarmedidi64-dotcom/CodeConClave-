# CodeConClave: Web-to-Local Files Bridge (PRODUCTION)

Browser controls desktop. Zero data leak. Same v3 arc — no new trust model.

## Mapping (nothing rebuilt)

| Bridge doc | CodeConClave (already built) |
| --- | --- |
| Local Daemon (read/write/delete/list/search, git, terminal) | `local-agent/` (`files.ts`, `terminal.ts`, `policy.ts`, `diff.ts` + rollback) inside Electron shell (`desktop/`) |
| Encrypted tunnel + heartbeat + reconnect | Remote pairing (`LOCAL_AGENT_WS_URL`, presence, heartbeat + attempt fencing) |
| Approval modal (30s timeout→deny, CRITICAL flags) | Approvals center + repair-max-2 → Escalate |
| Audit `.jsonl` + tables | Ledger + audit log + DNA (`ingest_runs`, artifacts with hashes) |
| Path guard + blocked `.env`/`.git`/`node_modules` | Gate·sentinel: traversal deny, secrets deny, workspace scope, ownership on every write |

## Command table (daemon ↔ web-client relay)

- `FILE_READ`, `FILE_WRITE` (approval), `FILE_DELETE` (CRITICAL approval), `FILE_LIST`, `FILE_SEARCH`
- `PROJECT_STATUS`, `PROJECT_STRUCTURE`
- `GIT_STATUS`, `GIT_COMMIT` (approval), `GIT_PUSH` (HIGH approval)
- `TERMINAL_RUN` (HIGH approval, allow-list policy, 30s timeout)
- `APPROVAL_REQUEST` / `APPROVAL_RESPONSE` (30s timeout → deny)
- `HEARTBEAT` (30s)

## Rules (non-negotiable, enforced on-device)

1. All file ops stay LOCAL — only commands/metadata cross the wire.
2. Writes/deletes/commits/pushes/terminal = approval, timeout denies.
3. Paths must stay inside the granted workspace; secrets (`.env`, keys, stores) never read.
4. Every op → Ledger receipt (who/what/hash/verdict). Kill switch + revoke kills in-flight.

## Quick start

1. Laptop: pair via `/remote` code → `serve` → ONLINE → grant ONE workspace folder.
2. Browser: Home → Cowork → `list my project files` → real listing + receipt.
3. Edit from chat: diff + backup + approval → apply → rollback available.

## Saturday demo script

1. Open desktop app → Home (`Hi Saharsh`, CodeConClave AI, Cowork default).
2. `list my project files` → real files + receipt.
3. `Fix the bug in auth.ts + add tests` → diff shown → Approve.
4. File saved LOCALLY. Audit row: user/file/WRITE/SUCCESS.
5. Say: "Web interface controls your desktop. Zero data leak. Verified, not claimed."
