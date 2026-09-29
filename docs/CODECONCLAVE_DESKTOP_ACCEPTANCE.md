# CodeConClave — Desktop Acceptance

Scope: the Electron shell (`.desktop/`) and its capability-gated local agent.
Status: IMPLEMENTED + AUTOMATED-TESTED. NSIS install/run and offline-on-a-flight
are human-only checks (see section 4). Nothing below claims a live installed
app was exercised in this pass unless a section explicitly says so.

## 1. Package layout (verified in `.desktop/package.json`)
- `appId com.codeconclave.desktop`, `productName CodeConClave`, Electron 44,
  `asar: true`, NSIS x64 target, one-click off, install-dir selection allowed.
- `main: dist/main/index.js`; preload bundled by `scripts/bundle-preload.mjs`;
  `npm run build` = `tsc` + preload bundle.
- Electron binary pinned to the workspace `electron/dist` (no network download).

## 2. Automated verification (state as of this pass)
- `npm run typecheck` — PASS.
- Server/cluster tests (`src/cloud`, `src/desktop`):
  - Network failure maps to `offline + UNKNOWN` — never a fabricated state. PASS.
  - Offline recovery backs off and reports recovery EXACTLY once. PASS.
  - Offline-safe resume returns `{ ok:false, error:'offline', resumed:false,
    changed:false }` and never invents cloud state. PASS.
  - Offline cowork resume reports offline without inventing state. PASS.
- `npm run test` (vitest unit suite) — PASS.

## 3. Capability model (verified in `src/cloud`, `src/desktop/app.ts`)
- Only the configured backend origin (or the offline shell) is ever trusted;
  everything else is refused at the boundary.
- Local-agent capabilities are gated by real entitlements; nothing is faked
  when a capability is unavailable (returns a defined denial, not a lie).

## 4. Human acceptance steps (NOT yet performed)
1. `npm run package:desktop` from a FRESH output dir (stale `release/win-unpacked`
   causes `EBUSY`/ENOTEMPTY on Windows), producing `release/CodeConClave Setup *.exe`.
2. Run the installer; confirm NSIS wizard, install-dir choice, short arc to the
   Start-menu launch.
3. Launch `CodeConClave.exe`; confirm: window opens to the app; tray/first-run
   wiring is intact; content loads against the configured backend.
4. Disconnect the network: start a cowork; expect an explicit OFFLINE state,
   a defined denial (never a fabricated result), and a clean resume when the
   network returns with EXACTLY ONE recovery report.
5. Verify `app.asar` bundles only `dist/**` + `assets` and excludes `src/**`,
   `*.test.*`, `*.map`.
6. Configure a mis-referenced target origin and confirm the shell refuses it.