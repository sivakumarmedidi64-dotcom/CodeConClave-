# CodeConClave — Desktop Acceptance Workbook (Gate: DESKTOP_E2E)

Companion to `CODECONCLAVE_DESKTOP_HUMAN_ACCEPTANCE.md`. Created per Prompt 5/5.
Nothing here may be auto-passed. The founder runs the 30 steps on the REAL
installed app (NOT a dev-run) and records real evidence.

Creator: System automation (scaffold + audit assertions only).
Verifier: Founder (performs every step; evidence below is blank until real).

INSTALLER SHA256 (current build, rebuilt 2026-09-10):
`52AF5BF2C8E2E8850120973555DA1F929CAE21A5239475ECECF24B0EBDDD6332`

---

## Gate DESKTOP_E2E — Desktop full product E2E

- **START**: Clean Windows machine with the real
  (SHA256-verified) `desktop/release/CodeConClave Setup 0.1.0.exe` present.
  Desktop app is configured to the SAME backend origin as the web app.
- **EXPECTED**: Installed desktop app is the same product as the web app —
  same auth, same AI gateway, same routing, same memory/tasks — and behaves
  correctly across restart, offline, and reconnect.
- **ACTION** (30 steps, in order):
  1. Verify installer SHA256 equals the published hash.
  2. Install: NSIS runs cleanly.
  3. Start Menu launch works.
  4. Desktop shortcut launch works (if created).
  5. Restart launch works.
  6. Google sign-in against the SAME backend origin.
  7. Onboarding (display name if missing; role; primary use case).
  8. Home dashboard renders.
  9. Real AI chat: safe text prompt where a valid provider exists.
  10. Streaming renders incrementally.
  11. Conversations persist across restart.
  12. Named conversations persist.
  13. Model/provider selection matches the registry.
  14. AI Coworkers render; task status real; NO manus/devin auto-tasks.
  15. Projects persist.
  16. Tasks persist.
  17. Memory persists.
  18. Control Plane renders.
  19. Files/workspace respect permissions.
  20. Terminal/runtime where permitted renders output within permissions.
  21. Permissions/approvals enforce.
  22. Activity/audit records entries.
  23. Settings/profile persist (display name).
  24. Error states: no blank screens, no renderer console errors.
  25. Secrets: NOT shown in renderer/preload or logs.
  26. Restart preserves state (signed-in, conversations, tasks).
  27. Network disconnect → single offline/reconnect state; task resumes on
      reconnect; close/reopen offline has no data corruption or duplication.
  28. Uninstall removes the app; no lingering process/service; `shutdown` at
      exit verified (no process left named like the app).
  29. Reinstall after uninstall works.
  30. End of flow: app and web still point at the same backend state.
- **EVIDENCE**: install/uninstall screens, SHA256 match output, runtime
  screenshots per step, offline/reconnect captures, task state before/after.
  No secrets.
- **PASS CONDITION**: all 30 steps behave as expected; hash matches; same
  product parity with web; no lingering processes; no Electron errors.
- **FAIL CONDITION**: any step fails; SHA256 mismatch; offline resume loses or
  duplicates data; any secret in renderer/preload/logs.

CURRENT GATE STATUS: **NOT_PERFORMED** (founder to perform; evidence lives in
`CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE.md` entry for DESKTOP_E2E).