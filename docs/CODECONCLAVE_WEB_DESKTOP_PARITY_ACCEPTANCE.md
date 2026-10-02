# CodeConClave — Web/Desktop Parity Acceptance

Gate: **WEB_DESKTOP_PARITY** (evidence gate 8 of 9). Human-only — run by the founder.

## Rule

The desktop app is NOT a separate product. It is the same CodeConClave served to the same
backend. Parity fails if any of the following differ between Web and Desktop while signed in
with the SAME account against the SAME canonical origin.

## Comparative checklist

| Area | Check on BOTH clients |
|---|---|
| Backend | Both hit the same canonical origin; no second/staged backend for desktop |
| Auth/session | Same session model; same `cc_session`-cookie-backed security on the same origin |
| AI gateway | Same responses to the same prompts (run identical prompt on both) |
| Routing | Same model-routing policy; same routed provider shown transparently |
| Provider registry | Same provider set, same health/status ledger on both |
| Memory | A memory saved on Web is visible on Desktop and vice-versa |
| Task state | Same task list and task lifecycle visibility |
| Projects | Same project list/state immediately (no sync delay) |
| Permissions | Same role-based visibility of admin/Control-Plane controls |
| Audit | Same audit events render on both |
| Payment entitlement | Same plan/entitlement reflected on both (frozen payment architecture) |
| User/workspace data | Same display name, workspaces, conversations, files |

## Steps

1. Sign in on Web (canonical origin) with a Google account.
2. Create a named project + task + one memory on Web.
3. Sign in on Desktop pointing at the same origin, same account.
4. Verify Desktop shows the SAME project, task, memory, and conversation immediately.
5. Send the identical prompt on both; verify the response comes from the same backend
   (equivalent model output / routed provider shown).
6. Create a project + memory on Desktop; verify they appear on Web without manual sync.
7. Compare settings/visible controls; role-based permissions must match.
8. Compare the plan/entitlement surface; must match.
9. Close both; reopen both; states persist on both.
10. Record side-by-side screenshots for the evidence log.

## Pass criteria

No material divergence in backend, data, entitlements, or behavior between the two clients.
Differences limited to UI chrome (window chrome, keyboard shortcuts) are acceptable and
should be noted.

## Recording evidence

Complete Gate 8 in `CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE.md` AND
`CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE.json`. Never invent results.