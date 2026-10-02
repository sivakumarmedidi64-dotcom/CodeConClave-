# CodeConClave — Windows Install Acceptance (Gate: WINDOWS_INSTALL)

Insists on the REAL installer everywhere. The disk-produced installer has to be
the one that ships. Nothing here may mark this gate PASS without clicking the
installer and watching it happen on a real Windows machine.

INSTALLER FILE: `desktop/release/CodeConClave Setup 0.1.0.exe`
LAST BUILD (automated): 2026-09-10 · SIZE: 106.3 MB
INSTALLER SHA256 (published, current build):
`52AF5BF2C8E2E8850120973555DA1F929CAE21A5239475ECECF24B0EBDDD6332`

## Pre-conditions

- The release installer is rebuilt from the exact release candidate code
  (`npm run package:desktop`), then the SHA256 is re-verified before publishing.
- RECALCULATE before signing off: any rebuild changes the hash.

## Steps (founder performs on a clean Windows machine)

1. **Verify the hash** — copy `desktop/release/CodeConClave Setup 0.1.0.exe`
   from the machine where it was built, then check:
   `Get-FileHash -LiteralPath "path\to\CodeConClave Setup 0.1.0.exe" -Algorithm SHA256`
   This value MUST equal the published hash above.
2. Run the installer.
3. Launch the app from the Start Menu.
4. Launch the app from a desktop shortcut (if one was created by the installer).
5. Restart the machine, then launch again.
6. Uninstall through Settings → Apps if available (or the installer's uninstall
   path). Confirm the app is gone and no background service remains.
7. Run the installer again; confirm a fresh install works after uninstall.
8. Sanity: sign-in + one AI chat runs on the installed app (via the SAME backend
   as the web app — the desktop app never talks to a different backend).

## Foundational checks (document alongside the evidence)

- `shutdown` at exit — no lingering process or service named like the app.
- Renderer/preload do not embed secrets. Renderer gets entitlements/plan via
  IPC, not raw credentials.
- Installer doesn't show unsigned/custom runtime prompts the user has to bypass.
- The SHA256 recorded in the evidence docs is the hash of the exact file the
  founder just installed (updated 2026-09-10 to the rebuilt installer).

## Fail conditions

- SHA256 mismatch. · Install fails. · App won't launch. · Shortcut broken.
- Uninstall leaves artifacts/processes. · Reinstall fails. · Silent failures.
- Any unsigned/custom-prompt bypass required.

## Evidence record (same gate in `CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE`)

TEST NAME: WINDOWS_INSTALL
DATE: (blank until performed)
OBSERVED RESULT: NOT_PERFORMED
PASS/FAIL: (blank)
EVIDENCE DESCRIPTION: (sha256 verified; install log; screenshots; uninstall; reinstall — no secrets)