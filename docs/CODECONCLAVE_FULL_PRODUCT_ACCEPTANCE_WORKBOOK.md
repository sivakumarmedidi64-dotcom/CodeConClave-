# CodeConClave — Full Product Acceptance Workbook (Gate: FULL_PRODUCT)

Created per Prompt 5/5. The FULL_PRODUCT gate passes ONLY when WEB_E2E,
DESKTOP_E2E, and WEB_DESKTOP_PARITY all PASS with real founder evidence. This
workbook restates each dependent gate with START / EXPECTED / ACTION / EVIDENCE /
PASS CONDITION / FAIL CONDITION and then the aggregate sign-off.

Creator: System automation (scaffold + audit assertions only).
Verifier: Founder (performs; evidence blank until real).

---

## Dependent gate A — WEB_E2E

See `CODECONCLAVE_WEB_ACCEPTANCE_WORKBOOK.md` (35 steps).
- START / EXPECTED / ACTION / EVIDENCE / PASS CONDITION / FAIL CONDITION:
  as defined in the web workbook.
- STATUS: NOT_PERFORMED (must be PASS for aggregate).

## Dependent gate B — DESKTOP_E2E

See `CODECONCLAVE_DESKTOP_ACCEPTANCE_WORKBOOK.md` (30 steps).
- START / EXPECTED / ACTION / EVIDENCE / PASS CONDITION / FAIL CONDITION:
  as defined in the desktop workbook.
- STATUS: NOT_PERFORMED (must be PASS for aggregate).

## Dependent gate C — WEB_DESKTOP_PARITY

- **START**: Same account, same backend, same canonical origin; browser +
  installed desktop both signed in at the START of the test.
- **EXPECTED**: The desktop app is NOT a separate product: same data, same
  auth/session model, same AI gateway, same routing, same provider registry,
  same memory, same task state, same permissions, same audit, same payment
  entitlement, same user/workspace data.
- **ACTION** (verify on both clients, same account):
  1. Same Home dashboard data.
  2. Same conversations appear on both.
  3. Same named conversations.
  4. Same projects/tasks/memory.
  5. Same model/provider selection and routing outcome for the same prompt.
  6. Same entitlement/limits.
  7. Change made in web → visible in desktop and vice versa.
  8. Audit/activity identical.
- **EVIDENCE**: screenshots from both clients showing the same state and the
  same responses; no secrets.
- **PASS CONDITION**: every shared state matches on both clients; responses via
  the same backend behave identically.
- **FAIL CONDITION**: any divergence in shared state; desktop showing different
  data/AI/entitlement than web.
- STATUS: NOT_PERFORMED (must be PASS for aggregate).

## Aggregate — FULL_PRODUCT

- **START**: Founders has completed and recorded gates A, B, and C as PASS in
  `CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE.md` + `.json`.
- **EXPECTED**: The product is release-ready from a human-acceptance
  standpoint: all automated checks green AND all human gates have real
  evidence.
- **ACTION**: Confirm gate A (WEB_E2E) = PASS, gate B (DESKTOP_E2E) = PASS,
  gate C (WEB_DESKTOP_PARITY) = PASS; aggregate their evidence into this
  workbook; record the aggregate result.
- **EVIDENCE**: pointers to the three gates' evidence + aggregate summary.
- **PASS CONDITION**: A, B, and C all PASS; the acceptance status engine then
  reads 9/9 PASS and `RELEASE_READY = YES`.
- **FAIL CONDITION**: any of A/B/C not PASS; no invented evidence.

CURRENT GATE STATUS: **NOT_PERFORMED**.

---

## Sign-off

Founder signature: ______________  Date: ______________
(Only when ALL nine gates carry real evidence and PASS in the evidence log.)