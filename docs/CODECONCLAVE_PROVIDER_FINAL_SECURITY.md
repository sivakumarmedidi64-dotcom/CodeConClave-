# CodeConClave Pro — PROVIDER FINAL SECURITY (Prompt 5)

Generation: 2026-09-08.

## Secret scan

```
secret-scan: files=847 skipped=0 findings=0
```

Scanned: `backend/`, `frontend/`, `desktop/` (incl. `desktop/src` preload/IPC),
`release/` installer builds, `shared/`, `scripts/`, docs, migrations, assets.
Zero findings. No `.env` inside any source, frontend, Electron, build artifact,
installer, log, audit, screenshot, memory table, or error response.

## Key locality

| Location | Keys? |
| --- | --- |
| `.env` (repo root) | YES — sole source; gitignored (`.gitignore` lines 13-16: `.env`, `.env.*`, `!.env.example`) |
| `.env.example` | no secrets (only structure; `GITHUB_PRIVATE_KEY=` empty) |
| `backend/src/modules/ai/providers.ts` | reads from `env.*` only; never logs |
| `frontend/` | none |
| `desktop/` | none (only a negative test assertion matches key-like patterns) |
| `shared/` | none |
| DB tables (incl. memory) | none — keys never stored; usage/audit store ids/metadata only |
| error responses / SSE | none (image candidates are client-side payloads after server auth; provider errors normalized to `AppError` codes) |

## Electron hardening (desktop)

- `webPreferences`: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, `webSecurity: true`, preload-only bridge
  (`desktop/src/electron/bootstrap.ts:105-111`).
- `will-navigate` allow-list; `setWindowOpenHandler` deny all; every
  `setPermissionRequestHandler` denied (`bootstrap.ts:114-118`).
- No direct provider access from the renderer: AI only via the same REST/SSE
  backend contracts the web app uses. No provider keys in IPC channels
  (`desktop/src/ipc/channels.ts` reviewed).

## Key-state honesty (no fabrication)

- `providerKeyState` (`providerKeySpec.ts`) returns one of:
  `MISSING_KEY | KEY_INVALID | ENVIRONMENT_BLOCKED | VERIFIED | UNVERIFIED |
  PROVIDER_UNAVAILABLE`, derived from verified facts; `KEY_INVALID` is never
  auto-upgraded to `ENVIRONMENT_BLOCKED`; `big_pickle` is permanently
  `ENVIRONMENT_BLOCKED` and `OPENCODE_ZEN_API_KEY` is absent from `.env`.
- UI renders state text only and never prints `ONLINE` for an unhealthy
  provider (ModelPicker now surfaces honest key-state hints from
  `/api/v1/ai/providers`).

## Behavioral guards (already enforced)

- No `console.log` of headers/keys; gateway and adapters normalize failures to
  `AppError` codes (`provider_not_configured`, `agent_not_configured`, …).
- Real image candidates are base64-in-memory only, persisted via
  `persistGeneratedImage` (owner-scoped project file), referenced by file id —
  never embedded in logs or audit payloads.
- CSP/CORS/auth scoping unchanged and green (auth suite).

## Residual notes

- `.gitignore` whitelists `!.env.test.example`, but no such file exists — use
  the root `.env.example` as the template (NOTE, non-security).
- Operator must keep `AI_PROVIDERS_ENABLED`/`…_API_KEY` values out of any
  shared shells; keys are the founder's to rotate if ever leaked.