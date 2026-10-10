# LIVE-WIRE PROOF — Web-protocol → local-agent → real files (no mocks on the wire)

**Date (UTC):** 2026-10-10. **No deploy, no commit, no push.** Repo files changed: `local-agent/src/serve-scope.ts` (new), `local-agent/src/index.ts` (serve handlers), `local-agent/src/foundation/serve-scope.test.ts` (new). Harness lives in Temp only (`AppData\Local\Temp\opencode\live-ws\`), nothing test-only in the repo except the regression test.

## What was connected — LIVE, 10/10 COMPLETE

A faithful hub peer (same frames as `backend/src/modules/agent/ws.ts`: `register`→`ready`, `cmd {corrId, cmd}`→`cmd_result`/`cmd_stream`, same timeout honesty) drove the **real built agent** (`local-agent/dist/index.js serve`, rebuilt from current source) over a **real WebSocket** (`127.0.0.1:43121`), sending the **exact cmd shapes** `backend/src/modules/local-workspace/service.ts` sends:

| # | Step | Live result |
|---|---|---|
| 1 | register + ready handshake | ok (agent: "connected to cloud hub") |
| 2 | `workspaces.list` | real grant: root + `file_read,file_write,terminal_exec` |
| 3 | `file.list` (project root) | real entries (`src/`, `.env`), real sizes/mtimes |
| 4 | `file.read` app.txt | `hello wire v1`, 14 bytes, sha256 `e93ae44b…ac9dc6` |
| 5 | `file.diff` → v2 | real unified diff; beforeHash == read sha |
| 6 | `file.write` v2 | applied; backup `.codeconclave-backups/app.txt.e93ae44b433a.bak`; afterHash `d7b38f46…664387e1` |
| 7 | `file.read` re-read | bytes == v2, sha == afterHash (no fabrication possible) |
| 8 | `terminal.exec echo hello-live-wire` | streamed `$ echo…` + `hello-live-wire`, `exitCode 0`, `timedOut false` (real powershell spawn) |
| 9 | traversal read (`System32\…\hosts`) | denied: `path is not inside any granted workspace` |
| 10 | `.env` read / `rm -rf /` exec | denied (no canary in error); denied `policy_denied: dangerous command blocked by immutable policy` |

On-disk verification: `app.txt` contains v2; backup file exists. Transcript: Temp `live-ws/hub.log`.

## Two REAL defects found by the live run (both fixed, both re-proven)

1. **Serve file ops denied every nested path** (`capability file_read/file_write not granted` even with full grants). Cause: `hasCap(config, root.abs, …)` compared the workspace ROOT against the resolved FILE path — always false below root. The task path (`tasks.ts`) was unaffected, which is why unit tests never caught it. Fix: new `serve-scope.ts` — `workspaceFor` returns the matched grant; cap checks run against it. Regression: `serve-scope.test.ts` 5/5.
2. **`file.write` crashed on backup** (`ENOTDIR … app.txt\.codeconclave-backups`). Cause: `applyEdit` anchors backups at its scope root, but the handler passed the resolved FILE path. Fix: pass the grant root + workspace-relative path. Re-proven by step 6 above.

## Honest boundaries

- The hub peer stands in for the backend: **no backend auth/DB/audit, no Web panel** in this loop. What is proven: transport framing + agent enforcement + real execution — the exact halves the backend delegates to. Backend `local-workspace` mapping was mirrored frame-for-frame (verified against `service.ts`), not reimplemented.
- Full chain still needs: running backend + Postgres/Redis + real pairing + the `Local` tab build. Then the only swap is the hub peer → real backend; the agent side is now proven live.
- Pre-existing suites: local-agent 125/126 (sole failure = known non-TTY `terminal.test.ts` flake, untouched); secret-scan 1276 files / 0 findings; agent `tsc` build clean.
