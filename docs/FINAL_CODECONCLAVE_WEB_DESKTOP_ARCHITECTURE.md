# FINAL CODECONCLAVE WEB + DESKTOP ARCHITECTURE

**Date:** 2026-09-01 | **Author:** opencode (architecture/feasibility) | **Secret-free**
**Phase:** TRACK A — Web + Desktop. **This turn is architecture/feasibility only; NOTHING was deployed.**

---

## 1. Current verified state

- Web app = **LIVE** (the primary public entry point).
- P0 / P1 / P2 / P3 = **PASS**; regressions = NO; `FEATURES_REMOVED = 0`; security pass.
- Desktop app = **does not exist yet** (no Electron/Tauri/native shell anywhere in the repo).
- `local-agent` = a **Node.js CLI** already doing terminal/file/workspace + WebSocket transport to the backend.

---

## 2. Principal findings (audit)

### 2.1 Web app (live)
- **Stack:** React 19 + Vite 7 SPA, browser-only (uses `window`/`localStorage`/`fetch`/SSE). No desktop wrapper.
- **Auth:** opaque `httpOnly` `cc_session` cookie (only SHA-256 stored), CSRF double-submit, MFA, RBAC roles + plans in the auth context.
- **Transport:** REST for most things; SSE via `fetch` streaming for chat; an authenticated `/agent-browser` WebSocket relay EXISTS server-side but the current SPA uses REST polling (2.5s) for terminal/remote pages.
- **Backend call surface:** `POST /api/v1/conversations/chat`, `/terminal/*`, `/agent/*`, `/remote/*`, etc.

### 2.2 local-agent (the natural desktop host)
- Pure Node CLI (`codeconclave-agent`): `pair`, `serve`, `terminal`, `file`, `git` (trigger), workspace management. Headless — **no GUI**.
- **Transport:** HTTP pairing (`/api/v1/agent/pair` + device token) then an **outbound WebSocket** to the backend; 30s heartbeat, exponential-backoff reconnect.
- **Terminal:** `node:child_process.spawn` of bash/zsh/powershell with a state machine + SIGTERM→SIGKILL. **No PTY** (`node-pty` absent) → no true TTY/ANSI/resize.
- **Filesystem:** `node:fs` with policy + backup + atomic write + SHA-256. Cross-platform path handling (both separators).
- **Policy:** deny-by-default `policy.ts` (protected paths, dangerous commands, traversal/symlink defenses).
- **Config:** `~/.codeconclave/agent.json` mode 0600.

### 2.3 Security posture for a desktop client
Executable actions MUST pass the canonical chain:
`AUTH → CAPABILITY → STOP RULES → RESOURCE GOVERNOR → SANDBOX → AUDIT`.
Desktop must NOT give the cloud backend unrestricted local access. Local filesystem access stays local; every cloud request is explicitly capability-scoped. The backend already namespaces capabilities per workspace and the local-agent is deny-by-default — this is the foundation the desktop reuses.

---

## 3. Desktop shell decision (DECISION — return before large-scale implementation)

**Decision: ELECTRON.**

Chosen by the audit criteria in the directive, not marketing:

| Criterion | Electron | Tauri (rejected) |
|-----------|----------|------------------|
| Use existing local-agent architecture | **Yes** — main process runs the existing Node local-agent engine (terminal/files/hub) unchanged, plus `node-pty` for a real terminal | No — local-agent is Node; driving it from Rust requires rewriting or FFI |
| Reuse existing React 19 SPA | **Yes** — renderer loads the existing web UI | Yes (webview), but requires Rust toolchain + a parallel Rust core |
| Dev delta / smallest appropriate | **Lowest** — all TS/JS, adds one process + native pty | Higher — new Rust core, new build toolchain, must replicate Node fs/pty/hub |
| Security | Main/preload IPC with capability-gated bridge; contextIsolation + sandbox on | Stronger Rust boundary, but moot if core stays Node |
| Filesystem / terminal / Git | `node:fs` + `node-pty` + existing local-agent (best fit) | Needs Rust (fd/walkdir/rust-pty) or FFI — larger |
| Memory footprint / cross-platform | Heavier, but mature on Win/macOS/Linux | Lighter, but shell recompute cost |
| Maintainability | Single language (TS) across web/agent/desktop | TS web + Rust desktop/Rust agent split |

**Rationale** (the deciding factors): the project already has a cross-platform **Node** local-agent with correct Windows/POSIX handling; Electron lets the desktop **reuse that engine** directly and gives a real terminal via `node-pty` + `xterm.js`. Tauri would force a Rust re-implementation of the terminal/filesystem/hub — the opposite of "smallest appropriate" and "use local-agent where possible."

### 3.1 Desktop architecture (proposed foundation)
```
+------------------------------------------------------------------+
| DESKTOP (Electron)                                               |
|                                                                  |
|  Renderer: existing React 19 SPA (web build served in-shell)     |
|     └─ embedded web UI: cowork, terminal, git, memory, tasks,    |
|        scheduling, team, notifications, command palette, voice   |
|                                                                  |
|  Preload: window.codeconclave (contextBridge)                    |
|     └─ exposes ONLY a capability-gated bridge (least privilege)  |
|                                                                  |
|  Main process:                                                    |
|     ├─ local-agent engine (reused): terminal(node-pty)/file/git  |
|     ├─ HubClient (WS) → backend `/agent-browser` (session auth)  |
|     ├─ local policy (deny-by-default, reuse local-agent policy)  |
|     └─ OS integration: tray, notifications, auto-start, safe quit|
+------------------------------------------------------------------+
        │ authenticated WS/SSE + capability-scoped API calls
        ▼
+------------------------------------------------------------------+
| BACKEND (unchanged, single system)                               |
|  AI OS P0–P3 · auth · cowork · memory · skills · scheduling      |
|  team state · entitlements · payments · security policies        |
+------------------------------------------------------------------+
```

Division of responsibility:
- **LOCAL (desktop):** filesystem, terminal, Git, local workspace watch, local execution, local device access, local policy enforcement — all enforced locally by the desktop's deny-by-default policy + canonical chain; cloud can never invoke these directly beyond the granted capability-scoped bridge.
- **CLOUD (backend):** account, auth/session, AI OS state, memory sync, cowork coordination, background execution, scheduling, team state, notifications, entitlement — reachable only through authenticated, capability-scoped API/WS/SSE.

### 3.2 Reused IPC/SSE primitives (no second system)
- Desktop connects with **the same user session** (login/logout reuses `/api/v1/auth/*`) — one account across Web + Desktop.
- Live push uses the existing `/agent-browser` WebSocket + SSE patterns; no new backend.

### 3.3 Security for the desktop bridge (canonical chain is NOT bypassed)
- Renderer ↔ main IPC is **capability-gated** (preload exposes only allowed actions).
- Every executable local action passes **local policy → stop rules → resource governor → sandbox → audit**, mirroring the backend chain.
- Cloud requests from desktop are **explicitly capability-scoped**; no generic "remote shell into this machine".
- **node-pty** adds no host risk beyond the existing local-agent model (the shell runs as the local user, exactly as the CLI does today).
- Secrets never cross into the renderer; local config stays `0600`.

### 3.4 Scope of the first desktop pass (foundation only)
Login/logout, workspace selection, local workspace detection, and the shell hosting the web UI. Advanced items (terminal via pty, git diff view, breakpoint/replay/undo, command palette, voice, background task monitor, mobile companion) are **foundation-then-increment** — explicitly NOT all in one pass.

---

## 4. Feature preservation

- Web app stays the primary live entry point; its behavior is preserved.
- local-agent continues to work as a headless CLI (desktop adds a GUI host; it does not replace the CLI).
- Desktop is an additional first-class client sharing the SAME user account, auth, AI OS, cowork, memory, skills, tasks, schedules, team state, entitlements, and security policies. No second backend.
- `FEATURES_REMOVED = 0` (full matrix updated separately).

---

## 5. What can be built safely WITHOUT changing production (dependency plan, Track A)

The following are additive, isolated, production-safe and are the recommended next implementation slice (pending approval):

1. **Desktop workspace skeleton** (`desktop/`) — a new Electron workspace hosting the existing web SPA locally; no backend change.
2. **Capability-gated preload bridge** — additive; no production code touched.
3. **`node-pty` terminal** wired to the existing local-agent policy — local-only.
4. **Reuse of `/agent-browser` WS** for live desktop push (backend already exposes it; no backend change).

NOT in the first pass: any migration, any production var change, any deployment, any entitlement/payment change.

---

_This document is a feasibility/architecture deliverable. Implementation requires explicit approval._
