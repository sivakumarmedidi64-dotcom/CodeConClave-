# CodeConClave — Full Product Human Acceptance

Gate: **FULL_PRODUCT** (evidence gate 9 of 9). Human-only — run by the founder.

## Rule

FULL_PRODUCT passes ONLY when every prior product gate is PASS with real evidence:
- Gate 6 WEB_E2E — PASS (evidence in `CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE.*`)
- Gate 7 DESKTOP_E2E — PASS
- Gate 8 WEB_DESKTOP_PARITY — PASS
Plus the platform gates that the product depends on:
- Gate 1 GOOGLE_OAUTH_LOGIN — PASS
- Gate 2 PRODUCTION_PAYMENT — PASS (or documented free-tier acceptance where the founder
  confirms the frozen payment architecture is untouched)
- Gate 3 WINDOWS_INSTALL — PASS
- Gate 4 OFFLINE_MODE — PASS
- Gate 5 PROVIDER_REPROBE — PASS

## Combined scenario (end-to-end)

1. Fresh clean Windows machine.
2. Install CodeConClave via the installer (SHA256 verified).
3. Launch Desktop, sign in with Google on the canonical origin.
4. Open the SAME account in a Web browser at the same origin.
5. On Web: create a project, a task, save a memory, send a real AI chat, generate one
   image (where configured) or confirm the honest unavailable state.
6. Switch to Desktop: the same project/task/memory/conversation are present.
7. On Desktop: complete a task; add a memory; reconnect after an offline window (per
   OFFLINE_MODE) and confirm the state survived.
8. Confirm the payment surface is unchanged and the entitlement matches on both clients.
9. Run the provider status surface on both; statuses match the honest ledger.
10. Confirm no secrets/tokens/keys ever appear in either client UI or logs.

## Pass criteria

Gates 6, 7, 8 all PASS; platform gates pass; the combined scenario completes without
data divergence, lockouts, or fabricated states.

## Recording evidence

Complete Gate 9 in `CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE.md` AND
`CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE.json`. Never invent results.
Only after all nine records are PASS in BOTH files may the founder move to deployment.