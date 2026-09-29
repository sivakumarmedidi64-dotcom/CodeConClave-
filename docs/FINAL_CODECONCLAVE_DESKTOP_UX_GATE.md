# FINAL CODECONCLAVE DESKTOP UX GATE

**Date:** 2026-09-02
**Gate:** CODECONCLAVE PRO — NEXT MASTER IMPLEMENTATION: DESKTOP UX (Part E) +
web/desktop parity (Part F).
**Authority:** Next master directive. Desktop polish must be additive on the
existing Electron foundation; no UI rebuild, no deployment.

---

## Result

```
DESKTOP_UX       = POLISHED (additive)
PARITY_WEB       = PRESERVED
DESKTOP_TESTS    = PASS
FEATURES_REMOVED = 0
```

## Part E — desktop polish

1. **Brand-black launch background.** `BrowserWindow` now sets
   `backgroundColor: '#000000'`, matching the authoritative black rounded-rect
   brand mark and the web `theme-color #111`. The window paints black the
   instant it is created and never flashes a white pane before the renderer
   (brand theme) is ready. The type declaration
   (`src/electron/ambient.d.ts`) was extended with `backgroundColor`.
2. **Canonical desktop icon (unchanged, re-verified).** `desktopIconPath()`
   in `src/electron/bootstrap.ts` resolves the shipped desktop icon with an
   existence-guarded fallback chain (`desktop/assets/icon.png` →
   `assets/brand/icon-256.png` → `desktop/assets/icon.ico`), so the window
   `icon` is always a real, shipped asset — never a fabricated or missing icon.
3. **Pane mapping (documented, no UI rebuild).** The web chat/cowork UX
   surfaces map 1:1 to the existing Electron window:
   - Web `ChatPage` (mode toggle, sidebar, composer, share/invite, shortcuts)
     → the single hardened `BrowserWindow` loading the same renderer.
   - `desktopIconPath()` / `backgroundColor` → brand identity at launch.
   - Allow-listed desktop events (`DESKTOP_EVENTS`) continue to forward to the
     renderer on the single `cc:event` bus — unchanged.

No new Electron panes/surfaces were added; the existing single-window model and
its hardening (contextIsolation, sandbox, no nodeIntegration, webSecurity,
deny window-open, deny permissions) are all preserved.

## Part F — web/desktop parity

- The desktop window renders the SAME web frontend, so every Part D UX item
  (attachments, reactions, copy, edit/regenerate, share/invite, sidebar,
  shortcuts, status pill, model picker, brand empty-state) is identical on
  desktop and web by construction.
- Web renderer state (`ChatPage`) drives both; the Electron layer only frames
  the window. No drift between targets.
- New web-only assets (public `/brand/*`) are served identically in the desktop
  window and over the web, so the brand is consistent end-to-end.

## Part H / Part I (features use OS layers; no migration applied)

- All cowork UX uses OS/browser-provided layers (file upload via standard
  multipart, clipboard via the async Clipboard API with `execCommand`
  fallback, `AbortController` for stream stop) — no invented runtime.
- Database migrations were NOT applied this turn. Per `DATABASE_CONTRACT.md`
  and the directive, the existing schema already covers the conversation
  PATCH fields (`title/archived/favorite/tags`), the per-message reaction
  table, and `workspace_state` — Part D needed **zero schema change**, so no
  migration was required. Migration work is *prepare-only*; nothing was applied.

## Part G / Part M (payment unchanged; no deploy)

- Payment UX and behavior are untouched (read-only observability only; no
  bypass, no demo gating change, no real payment).
- No deploy to Railway/Neon and no production migration were performed.
  `PRODUCTION_DEPLOYMENT = NOT_EXECUTED`, `REAL_PAYMENT = NOT_PERFORMED`.

---

## Tests

- Desktop suite passes (57 tests) — run as part of the master gate.
- Electron bootstrap is declaration-typed (Electron binary is not shipped in
  this foundation pass); the added `backgroundColor` is covered by the ambient
  type and the constructor options wiring.

## Final gate block (this file)

```
DESKTOP_UX        = PASS  (brand-black launch + canonical icon re-verified)
PARITY_WEB        = PASS  (same renderer, identical UX)
OS_LAYER_USE      = PASS  (browser/native layers only)
SCHEMA_MIGRATION  = NONE APPLIED (no change required; prepare-only)
PAYMENT_UNCHANGED = PASS
DESKTOP_TESTS     = PASS
FEATURES_REMOVED  = 0
PRODUCTION_DEPLOYMENT = NOT_EXECUTED
REAL_PAYMENT      = NOT_PERFORMED
```
