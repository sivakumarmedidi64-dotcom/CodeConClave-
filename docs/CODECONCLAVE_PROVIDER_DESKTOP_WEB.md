# CodeConClave — Provider Desktop ↔ Web Unification

**Directive:** CODECONCLAVE PRO PROMPT 1/5 — PROVIDER EXPANSION FOUNDATION + WEB + WINDOWS DESKTOP UNIFICATION.
**Date:** 2026-09-07

## The core principle: one backend, one provider registry

CodeConClave runs **one** Express backend (`backend/`) that serves **both** the browser Web App (`frontend/`) and the Electron Windows Desktop App (`desktop/`). Provider selection, routing, health tracking, entitlement, budget, and cost auditing happen in exactly one place. This document records how the two surfaces stay unified and secret-safe.

This satisfies `WEB_AND_DESKTOP_SHARE_BACKEND=YES`.

## Data/control flow

```
                        ┌──────────────────────────────────────────────┐
                        │            Express backend (backend/)         │
                        │  providers.ts · registry.ts · gateway.ts      │
                        │  status.ts · routes.ts · model_usage_logs     │
                        │  PostgreSQL (ai_model_registry + provider_*)  │
                        │  All provider API keys live here (env)        │
                        └──────────────▲──────────────────▲────────────┘
                                       │ cc_session (httpOnly cookie)
          ┌────────────────────────────┴─────┐    ┌────────┴──────────────────────┐
          │  Web App (frontend/)             │    │  Desktop (electron/)           │
          │  Browser SPA                     │    │  Electron shell                 │
          │  model picker / chat             │    │  thin client                     │
          │  reads /api/v1/ai/models          │    │  desktop/src/cloud/client.ts    │
          │  GET /api/v1/ai/providers         │    │  same cookie, same endpoints    │
          └──────────────────────────────────┘    └────────────────────────────────┘
```

## Web App

- `frontend/src/lib/types.ts` — `AiModel` interface reads whatever the backend `/api/v1/ai/models` returns, including the optional `capabilityCategory`.
- `frontend/src/components/ModelPicker.tsx` — renders the dropdown from the server list, honoring `available`/`locked`/`health`. A provider excluded by `configuredProviders()`, or `DOWN`, or an external agent not opted-in, is rendered non-selectable. **No model is invented; the server is the only authority.**
- The UI never holds or transmits provider API keys.

## Desktop App (Electron, Windows)

- `desktop/src/cloud/client.ts` — `BackendClient` calls the same backend with the same `cc_session` httpOnly cookie (`credentials: 'include'`). Foundation is read-mostly (GETs); state-changing cloud actions reuse the web UI's existing endpoints.
- `desktop/src/desktop/app.ts` — thin "capability/workspace model, the read-only backend client, reconnect, and the event bus — no second state model."
- `desktop/src/types.ts` — the desktop bundle is intentionally secret-safe: "no tokens, credentials, provider payloads, or raw …".
- **No provider id, no model id, no API key is hardcoded anywhere in `desktop/src`** (verified by grep). Provider data is consumed from the shared backend exactly like the web app.

## Provider registry consumption parity

| Concern | Web | Desktop | Shared? |
|---|---|---|---|
| Model catalogue source | `GET /api/v1/ai/models` | same endpoint | YES |
| Provider status | `GET /api/v1/ai/providers` | (same backend read API available) | YES |
| Capability category | `AiModel.capabilityCategory` | via shared backend payload | YES |
| Provider keys | server-only (never in bundle) | server-only (never in bundle) | YES |
| Routing/health/budget logic | backend `gateway.ts` | backend `gateway.ts` | YES |
| Audit/cost store | `model_usage_logs` | backend only | YES |

## Desktop provider security

- Credentials are never placed in the Electron main process beyond what the backend already gates; the renderer/preload receives **no** provider tokens.
- The desktop talks to the same `requireAuth`-protected AI endpoints; it cannot bypass entitlement, health, or budget policy because those are enforced server-side.
- New providers (qwen/gemma/devin) surface in the desktop exactly as in web: dynamically, from the shared registry.

## Gating summary

- `EXTERNAL_AGENT` (Devin) is excluded from normal chat routing in the gateway unless `allowExternalAgents: true` — applies equally to web and desktop chat paths.
- `Z_CODE_5_3` is `enabled=false` + `health=DOWN`, so it is absent from the live registry and from both web and desktop model surfaces.

## Verification notes

- Desktop typecheck/test suite is independent; run `npm run typecheck` and `npm run test` in `desktop/`.
- Web typecheck/test/build is independent; run in `frontend/`.
- Because both share the backend, the backend AI regression tests (foundation) cover the routing/health/cost logic used by both.
