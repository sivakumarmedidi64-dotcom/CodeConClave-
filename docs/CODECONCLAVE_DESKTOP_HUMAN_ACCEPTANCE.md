# CodeConClave — Desktop Human Acceptance (Gate: DESKTOP_E2E)

The desktop app is the Windows client of the same CodeConClave product and
`same backend`. Every step is run by a human on the real installed app. Nothing
here can pass from an automated test alone.

INSTALLER SHA256 (current build, rebuilt 2026-09-10):
`52AF5BF2C8E2E8850120973555DA1F929CAE21A5239475ECECF24B0EBDDD6332`

## 30-step desktop flow

Each row: ACTION / EXPECTED / EVIDENCE.

1. Installer launches. → NSIS runs. → screenshot of installer dialog.
2. Install completes. → app in Start Menu, launchable. → screenshot.
3. Launch app. → window + splash fit. → screenshot.
4. Restart and launch again. → app opens clean. → screenshot.
5. Sign in with Google. → identity + consent on the canonical origin. → screenshot.
6. Onboarding. → display name (auto/skip if set), role, primary use case. → screenshot.
7. Home. → Dashboard summary. → screenshot.
8. AI chat (real safe text call where a valid provider exists). → streaming response. → screenshot.
9. Streaming works. → tokens render incrementally. → screenshot.
10. Conversations. → list preserves past chats. → screenshot.
11. Named conversations. → rename persists. → screenshot.
12. New conversation. → fresh thread, no bleed from prior. → screenshot.
13. Model selection. → list shows providers from the honest registry. → screenshot.
14. Provider auto-routing. → routes to healthy provider, no fake fallback. → logs only.
15. Provider fallback where testable. → degraded/reauth provider does not break the chat. → logs only.
16. Attachments. → upload visible; file access respects permissions. → screenshot.
17. Multimodal/image input where configured. → passed through per registry capability. → screenshot.
18. Image generation where configured (honest: only if a real capability exists; else mark NOT_CONFIGURED). → screenshot.
19. AI Coworkers. → coworker panel renders. → screenshot.
20. Coworker task status. → task; no auto-creation for manus/devin. → screenshot.
21. Control Plane. → active tasks/workers/approvals render. → screenshot.
22. Projects. → project list/creation persists. → screenshot.
23. Tasks. → task list/creation persists. → screenshot.
24. Memory. → memory view; entries persist across sessions. → screenshot.
25. Control Plane (repeat). → still works after tasks run. → screenshot.
26. Files/workspace. → files list; upload/download respect permissions. → screenshot.
27. Terminal/runtime where permitted. → command output renders within permissions. → screenshot.
28. Permissions and approvals. → approval flows render and enforce. → screenshot.
29. Activity/audit. → entries recorded. → screenshot.
30. Settings/profile. → display name persists. → screenshot.

### Cross-cutting (record once)

- Error states: no blank screens; no uncaught renderer errors on the console.
- Secrets NOT shown in renderer/preload or logs.
- Restart preserves state (signed-in, conversations, tasks).
- Network disconnect → single offline/reconnect state, task resumes on reconnect.
- Close/reopen during offline → no data corruption/duplication.
- No critical Electron errors in logs.

## Fail conditions

Any step above fails, or a cross-cutting check fails.

## Evidence record (same gate in `CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE`)

TEST NAME: DESKTOP_E2E
DATE: (blank until performed)
OBSERVED RESULT: NOT_PERFORMED
PASS/FAIL: (blank)
EVIDENCE DESCRIPTION: (steps 1–30 screenshots + cross-cutting captures — no secrets)