# CodeConClave Pro — Web + Desktop AI Parity (Final — Prompt 5)

## Summary

Web and the Windows Desktop client ARE THE SAME APPLICATION on the same
backend. There is no desktop-side AI engine, no second router, and no key
material in the desktop shell. All frontend changes ship to Desktop with zero
desktop-specific code because the Electron renderer IS the web app.

## How it works

- `desktop/` is an Electron shell whose renderer IS the web app; its
  preload/IPC bridge (`desktop/src/preload`, `api.ts`) exposes only non-
  sensitive plumbing (workspace/terminal/device channels).
- Every AI surface goes through the shared REST + SSE contracts served by
  `backend`:
  - `GET /api/v1/ai/models` — catalogue incl. `capabilityClass`,
    `imageGeneration`, `imageEditing`, availability, lock, per-model health.
  - `GET /api/v1/ai/providers` — provider status + credential `keyState`
    (VERIFIED / KEY_INVALID / ENVIRONMENT_BLOCKED / UNVERIFIED /
    MISSING_KEY / PROVIDER_UNAVAILABLE) + server-authoritative `live` list.
  - `GET /api/v1/ai/routing` — explainable routing decision (Web + Desktop).
  - `POST /api/v1/conversations/chat` — SSE stream (incl. `image` and
    `external_agent` events) + `imageRequest`.

## Provider key state — the honest credential machine

True states (never collapseable; surfaced verbatim by `/providers`):

| State | Meaning | Auto-gate behavior |
| --- | --- | --- |
| `MISSING_KEY` | no server key | prompt to configure |
| `KEY_INVALID` | key stored, service rejects (401 …) | **NEVER auto-upgraded**; founder replaces the key |
| `ENVIRONMENT_BLOCKED` | verified route, no safe real call / never-add-key | UI explains; `big_pickle` permanent |
| `VERIFIED` | real call succeeded on live route | usable |
| `UNVERIFIED` | identity could not be established | honest text |
| `PROVIDER_UNAVAILABLE` | service unreachable (network/billing) | probe-backed |

Rules: `big_pickle` ⇒ `ENVIRONMENT_BLOCKED` (its key must never exist here);
missing key dominates; KEY_INVALID is never auto-upgraded to
ENVIRONMENT_BLOCKED; the UI renders state text and never fabricates
availability (`ONLINE` is never shown for an unhealthy provider).

## Scenario table

| Scenario | Web | Desktop | Secret exposure |
| --- | --- | --- | --- |
| Model picker + provider key-state hint | `/models` + `/providers` | same | none |
| Provider/Routing status | `/providers` + `/routing` | same | none |
| Chat / streaming | SSE | same | none |
| Image mode → generated image | SSE `image` + file preview + download | same | none |
| External agent run | SSE `external_agent` + state pill | same | none (id only) |

## Desktop security (verified in this gate)

- `webPreferences`: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, `webSecurity: true`, preload-only IPC
  (`desktop/src/electron/bootstrap.ts:105-111`).
- `will-navigate` allow-list enforcement; `window.open` denied; all permission
  requests denied (`bootstrap.ts:114-118`).
- No provider credentials anywhere in `desktop/src` (grep for
  `API_KEY|GEMINI|QWEN|OPENROUTER|x-goog|Bearer` matches only a negative test
  assertion). No `.env` in `desktop/`.

## Verification (Prompt 5 gate)

- Backend/frontend/desktop full suites green (see
  `CODECONCLAVE_PROMPT5_FINAL_AUDIT.md`); desktop tsc build + NSIS package
  (`release/CodeConClave Setup 0.1.0.exe`) built.
- Secret scan: 847 files, 0 findings (incl. desktop/preload/`release` bundles).
- ModelPicker now surfaces provider key-state hints from `/ai/providers`
  (5 tests, incl. KEY_INVALID rendering).
- Same auth, registry, routing, provider state, memory, permissions, task
  state, usage, audit, and workspace isolation for Web and Desktop — both
  consume the single backend control plane.