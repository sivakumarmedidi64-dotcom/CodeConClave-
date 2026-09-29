# CODEONCLAVE — MANUAL ACCEPTANCE CHECKLIST (Prompt 21 Part 19)

Founder-facing manual verification checklist. Every item has a concrete ACTION,
an EXPECTED RESULT, and a PASS/FAIL/NOTES column. Run against a live install
(backend on port 4000, frontend dev on 5173, or Packaged Windows Desktop).

Server-authoritative facts you should observe as "done by automation" are in
[CODECONCLAVE_PRODUCTION_READINESS_AUDIT.md](./CODECONCLAVE_PRODUCTION_READINESS_AUDIT.md).

| # | Area | ACTION | EXPECTED RESULT | PASS | NOTES |
|---|------|--------|-----------------|------|-------|
| 1 | Onboarding | Open the app unauthenticated | Login page renders; "Create account" link visible; no app-shell UI leaks anonymous data | | |
| 2 | Onboarding | Register with a new email | Email+password accepted; you land in an empty home view with a default conversation open; name captured | | |
| 3 | Onboarding | Register again with the SAME email | Rejected (409/422); clear "email already in use" message; no duplicate user row | | (verified by harness → 409) |
| 4 | Login | Log in with the registered account | Session set; refresh keeps you logged in; Sidebar shows your display name | | |
| 5 | AI CHAT | Open a conversation; type "Say the word: HEALTHY"; wait for SSR stream | Assistant reply streams token-by-token; a source/halo appears while thinking; no spinner freeze | | (verified by harness: 413-byte SSE stream) |
| 6 | AI CHAT | Reload the page after a completed exchange | Conversation still open; prior messages render in full from server state | | (verified by harness: messages count=2 removed) |
| 7 | AI CHAT | Verify the model label under the reply | Label matches a REAL provider (e.g. Google Gemini Flash / qwen / nemotron); never "unknown" | | |
| 8 | Multimodal | Send an image-style prompt (or attach image if quota available) | Image generation path returns an artifact rendered in-chat, or server says quota-exhausted honestly | | (google image-gen QUOTA_EXHAUSTED → honest UX) |
| 9 | Coworker | Create a project; open /coworkers; start a cowork run | Run executes via the central model router; state transitions RUNNING→VERIFYING→COMPLETED; output visible | | |
| 10 | Multi-chat | Create 3 conversations; send messages in each; switch between them | Each conversation keeps its own history/metadata; no cross-contamination | | |
| 11 | Free usage | As a NEW free user, send enough messages to hit the 24-hour rolling limit | System message reads "rolling-window limit reached"; Free-Limit Moon appears once; your work is untouched | | (wording updated 4 files + tests) |
| 12 | Provider status | Open Settings → AI provider list | Every provider shows an honest status: VERIFIED / QUOTA_EXHAUSTED / REQUIRES_REAUTH / KEY_INVALID / ENVIRONMENT_BLOCKED; no fabricated ONLINE | | |
| 13 | Security | Open /control (control plane) | Endpoints respond (owner-scoped); no cross-user data visible; kill-switch page is present | | |
| 14 | Security | Try to open another user's task/plan URL directly | 404/403 — never the other user's plan/steps/attempts | | (verified by harness: 6/6 blocked) |
| 15 | Accessibility | Press Tab from page load | A visible "Skip to content" link appears first; Enter jumps to main content | | (skip-link added) |
| 16 | Accessibility | Keyboard-navigate the Workspace tabs | Focus moves into tabs; aria-selected reflects the active tab | | (tab semantics in Workspace/Agents/Memory/Recovery pages) |
| 17 | Payments | Open upgrade/payment page | Plan switch / payment flow renders; NO payment code changes in this release | | (PAYMENT FROZEN) |
| 18 | Payments | Trigger a mock/claim payment (if available) | Razorpay webhook signature gate returns its normal code path; nothing regressed | | |
| 19 | Data | Open /history, /memory, /files | Your data is intact; reads are owner-scoped | | |
| 20 | Desktop | Run installed Windows desktop app | Shell loads; AI chat works; capabilities-gated local agent responds; parity with web for chat | | |
| 21 | Desktop | From desktop, open a second chat window | Independent conversation; no state bleed | | |
| 22 | UI/UX | Resize to a narrow width / open on mobile | Layout never horizontally overflows; key controls remain reachable | | |
| 23 | UI/UX | Toggle dark/light if available | Theme applies persistently across reload | | |
| 24 | Database | Run `npm run db:migrate:status` | 74 applied / 0 pending; the 0074 RLS GUC migration is present | | |
| 25 | Database | Run `npm run secret:scan` | 849 files / 0 findings | | |

## How to run each check

- Web: `npm run dev --workspace @codeconclave/backend` then `npm run dev --workspace @codeconclave/frontend`.
- Desktop: `npm run package:desktop --workspace @codeconclave/desktop` → run the installer.
- DB: `npm run db:migrate:status` and `npm run secret:scan` from the repo root.

## Sign-off

Approve (date + name) once all rows above are PASS (or have a documented, accepted
NOTES reason). Any FAIL must be resolved (or explicitly accepted by the founder)
before the FINAL PRODUCTION READINESS GATE is considered GO.