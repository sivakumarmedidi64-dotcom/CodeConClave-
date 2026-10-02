# CodeConClave — Web Acceptance Workbook (Gate: WEB_E2E)

Companion to `CODECONCLAVE_WEB_HUMAN_ACCEPTANCE.md`. Created per Prompt 5/5.
Nothing here may be auto-passed. The founder runs the 35 steps, records real
evidence, and only a PASS with evidence moves the gate.

Creator: System automation (scaffold + audit assertions only).
Verifier: Founder (performs every step; evidence below is blank until real).

---

## Gate WEB_E2E — Web full product E2E

- **START**: Clean browser profile, no prior CodeConClave session on the target
  canonical origin (`http://localhost:5173` for local acceptance; release origin
  at deployment). Desktop app (if running) points at the SAME backend.
- **EXPECTED**: A single sign-in grants access to the whole product: chat,
  routing, providers, coworkers, control plane, projects, tasks, memory, files,
  usage, settings — with the provider registry as-is (see honest ledger below).
- **ACTION** (35 steps, in order):
  1. Launch web app at the canonical origin; expect it to load.
  2. Google sign-in; consent screen on the same origin.
  3. Onboarding (display name if missing; role; primary use case); expect no
     re-ask of email/identity.
  4. Display-name persistence after reload.
  5. Home dashboard renders.
  6. Real AI chat: send a safe, benign text prompt where a valid provider
     (google/qwen/nemotron HEALTHY) exists.
  7. Streaming: tokens render incrementally.
  8. Conversations: the chat is preserved in the list.
  9. Named conversation: rename persists.
  10. New conversation: fresh thread, no bleed from the prior chat.
  11. Model selection: list matches the honest provider registry.
  12. Auto routing: routes to a healthy provider; no fake fallback.
  13. Provider fallback where testable (degraded/reauth provider does not break
      the chat).
  14. Attachments: upload works; file access respects permissions.
  15. Multimodal / image input where configured (per registry capability).
  16. Image generation where configured; if none configured, record NOT_CONFIGURED.
  17. AI Coworkers panel renders.
  18. Coworker task status reflects real state; NO auto-created task for
      manus/devin.
  19. Control Plane renders active tasks/workers/approvals.
  20. Projects: list/create persists.
  21. Tasks: list/create persists.
  22. Memory: entries persist; view renders.
  23. Project continuity: switching projects keeps the right context.
  24. Files/workspace: list; upload/download respect permissions.
  25. Terminal/runtime where permitted: command output renders within
      permissions.
  26. Connections/integrations surface renders (permission-gated).
  27. Permissions/security: protected surfaces enforce authz.
  28. Activity/audit: entries are recorded.
  29. Rolling usage: server reports the window; the UI only renders it.
  30. Settings/profile: display name persists.
  31. Error states: no blank screens, no uncaught console errors.
  32. Secrets: no credentials/tokens/keys appear anywhere in the UI.
  33. Payment unchanged: entitlement surface consistent with plan.
  34. Clean UI: no broken layout/overflow on the main flows.
  35. End of flow: logout → login returns to the same state.
- **EVIDENCE**: per-step screenshots + console capture; real AI response text;
  provider-status JSON with no keys/auth headers.
- **PASS CONDITION**: all 35 steps behave as expected with the honest registry
  (google/qwen/nemotron HEALTHY, openai/deepseek QUOTA_EXHAUSTED,
  anthropic/gemma OFFLINE, grok/kimi REQUIRES_REAUTH, rest NOT_CONFIGURED,
  manus/devin EXTERNAL_AGENT never auto-run, big_pickle NOT_INTEGRATED). No
  invented provider state. No secrets exposed.
- **FAIL CONDITION**: any step fails; a fake provider state is shown; any
  secret in UI; manus/devin auto-created tasks.

CURRENT GATE STATUS: **NOT_PERFORMED** (founder to perform; evidence lives in
`CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE.md` entry for WEB_E2E).