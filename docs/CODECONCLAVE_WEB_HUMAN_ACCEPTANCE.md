# CodeConClave — Web Human Acceptance (35-Step)

Gate: **WEB_E2E** (evidence gate 6 of 9). Human-only — run by the founder.

## Environment

- Browser: one modern browser (Chrome or Edge) for the whole run.
- Origin: exactly ONE canonical origin (the deployment URL). Use the same origin
  for every step. `GOOGLE_REDIRECT_URI` must equal `https://<host>/api/v1/auth/google/callback`.
- Record screenshots and console output. Never capture tokens or secrets.

## Steps

1. **Launch** — open the canonical origin. Page loads, no fatal console errors.
2. **Google sign-in** — click "Continue with Google", complete consent, return to app.
3. **Onboarding** — complete the welcome/onboarding flow to the Home screen.
4. **Display-name persistence** — set/modify your display name; reload; name persists.
5. **Home** — Home renders the expected sections with correct greeting/time context.
6. **Real AI chat** — send a prompt; receive a real model response (not a canned reply).
7. **Streaming** — confirm response streams (token-by-token) rather than loading then
   appearing all at once.
8. **Named conversation** — create a conversation with a name; it appears in the list.
9. **New conversation** — start a fresh conversation; previous context not carried over.
10. **Model selection** — select a specific available model; the UI shows the active model.
11. **Auto routing** — pick "auto"; confirm the router picks a provider and the UI shows the
    routed provider transparently.
12. **Provider fallback (where testable)** — with an unhealthy provider selected, confirm the
    gateway falls back to an available provider and the UI shows the fallback honestly.
13. **Attachments** — attach a file; confirm it is listed and accepted.
14. **Multimodal / image input** — if image input is configured, attach an image; confirm the
    model receives it.
15. **Image generation (where configured)** — request image generation; confirm the generated
    image is returned, persisted, attached to the conversation, and audited — or confirm the
    honest "unavailable/quota" state if it cannot run in this environment.
16. **AI Coworkers** — open the Coworkers panel; the coworker list renders.
17. **Coworker task status** — create/observe a coworker task; its status stays honest
    (running/failed/blocked — never a false "complete").
18. **Control Plane** — open Control Plane; it renders only for authorized users.
19. **Active tasks / workers / approvals** — the active task and worker lists render; approvals
    render for the authorized user.
20. **Projects** — create/open a project; it persists.
21. **Tasks** — create a task in the project; it persists.
22. **Memory** — save/recall a memory (e.g., a preference); it is usable later.
23. **Project continuity** — reopen the project; task and memory state is restored.
24. **Files / workspace** — open the file workspace; list/create a file.
25. **Terminal / runtime (where permitted)** — if runtime is enabled for your role, run a
    trivial command; confirm the result; otherwise confirm the permission-denied state is honest.
26. **Connections / integrations** — open the connections area; installed connections render.
27. **Permissions / security** — confirm role-based permissions reflect your account; admin-only
    controls are not visible to a standard user.
28. **Activity / audit** — open activity/audit; recent actions (login, chat, file) are listed.
29. **Rolling usage** — the usage/plan surface shows current usage for the active plan.
30. **Settings / profile** — open settings; profile fields render and update.
31. **Error states** — trigger an expected error (e.g., model unavailable); the UI shows a clear
    error, never a stack trace or raw secret.
32. **No secrets in UI** — confirm no API keys, tokens, auth headers, or payment credentials
    ever appear in the UI or network-visible DOM.
33. **Payment unchanged** — the payment/checkout surface is unchanged and matches the frozen
    payment gate (reservation → hosted link → callback → exactly-once entitlement).
34. **Clean UI** — no broken layout, no unclosed overlays, no flickering infinite loading.
35. **No critical console errors** — end the run; confirm no exceptions in DevTools console.

## Pass criteria

All 35 steps produce the expected observable result; evidence recorded for every step;
no secrets captured in evidence.

## Recording evidence

Complete Gate 6 in `CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE.md` AND
`CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE.json`. Never invent results.