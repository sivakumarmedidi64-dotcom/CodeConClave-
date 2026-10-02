# CodeConClave — Human Acceptance Evidence TEMPLATE

Use this template for every filled gate. **Copy the file, fill every blank, and
keep the original template empty.** Never write a credential, token, or secret
into any evidence record.

- TEST NAME: one of GOOGLE_OAUTH_LOGIN / PRODUCTION_PAYMENT / WINDOWS_INSTALL /
  OFFLINE_MODE / PROVIDER_REPROBE / WEB_E2E / DESKTOP_E2E / WEB_DESKTOP_PARITY /
  FULL_PRODUCT
- DATE: YYYY-MM-DD (only when performed, not when copied)
- ENVIRONMENT: browser + canonical origin; or Windows version + installed build
- BUILD VERSION: 0.1.0
- INSTALLER SHA256 (desktop gates only): 52AF5BF2C8E2E8850120973555DA1F929CAE21A5239475ECECF24B0EBDDD6332
- STEPS PERFORMED: (numbered real steps actually run)
- OBSERVED RESULT: NOT_PERFORMED (or PASS/FAIL once performed)
- PASS/FAIL: (blank until performed)
- EVIDENCE DESCRIPTION: (what was captured; no credentials/tokens/secrets)
- FOLLOW-UP ISSUE: (blank unless something was found)
- PERFORMED BY: (founder name) · PERFORMED AT: (timestamp)

Notes:
- Passwords/tokens/keys/OTPs NEVER go in evidence. Payment evidence = reference +
  dashboard + entitlement state.
- Never auto-skip the payload-evaluation steps. The stake of the Goa OAuth
  vendor-route handoff (authware/multi-step routing) belongs by design to the
  domain logic; gateway-side pass-through for OAuth journeys is not treated as
  a fake pass.
- Automated test/build results never satisfy a human gate.