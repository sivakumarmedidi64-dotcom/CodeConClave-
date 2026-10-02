# CodeConClave — Provider Release Status

Honest provider registry state for the release candidate, snapshot from live
re-probe evidence on 2026-09-10. No fabricated provider success. No fake
credentials were added. No provider entry was deleted. Providers that are not
configured are reported as NOT_CONFIGURED and, where relevant, guarded by the
`provider_health_state_check` column constraint.

Status categories used:

- HEALTHY — live probe succeeded; the provider is usable by the router now.
- QUOTA_EXHAUSTED — reachable but returned quota/billing errors (429). This is
  a credential/quota condition, NOT an implementation failure.
- REQUIRES_REAUTH — reachable but returned invalid_credentials; the key must be
  renewed by the founder.
- OFFLINE — reachable but returned a provider-side error (bad request /
  unavailable).
- NOT_CONFIGURED — no registry entry / no key configured; not probed.
- NEVER_AUTORUN — external agent providers; tasks are never auto-created.
- NOT_INTEGRATED — deliberately not integrated (Big Pickle); no
  OPENCODE_ZEN_API_KEY is added.

## Current ledger

| Provider    | Status            | Notes                                          |
|-------------|-------------------|------------------------------------------------|
| google      | HEALTHY           | live probe OK                                  |
| qwen        | HEALTHY           | live probe OK                                  |
| nemotron    | HEALTHY           | live probe OK                                  |
| openai      | QUOTA_EXHAUSTED   | 429 / rate limit (quota condition, not a bug)  |
| deepseek    | QUOTA_EXHAUSTED   | billing/quota error                            |
| anthropic   | OFFLINE           | bad_request from provider                      |
| gemma       | OFFLINE           | provider_unavailable                           |
| grok        | REQUIRES_REAUTH   | invalid credentials                            |
| kimi        | REQUIRES_REAUTH   | invalid credentials                            |
| mistral     | NOT_CONFIGURED    | no registry entry                              |
| north       | NOT_CONFIGURED    | no registry entry                              |
| ox_alpha    | NOT_CONFIGURED    | no registry entry                              |
| z_code_5_3  | NOT_CONFIGURED    | no registry entry                              |
| manus       | NEVER_AUTORUN     | external agent; tasks never auto-created       |
| devin       | NEVER_AUTORUN     | external agent; tasks never auto-created       |
| big_pickle  | NOT_INTEGRATED    | intentionally not integrated                   |

## Rules honored

1. Quota exhaustion is reported as the provider's real response — it is never
   disguised as an implementation failure.
2. No provider is disabled or deleted solely because of quota/reauth state.
3. The re-probe only persists states that exist in the DB constraint
   (`UNKNOWN, HEALTHY, DEGRADED, DOWN, RATE_LIMITED, QUOTA_EXHAUSTED,
   REQUIRES_REAUTH, OFFLINE, BLOCKED`); NOT_CONFIGURED/LIMITED/BLOCKED are
   handled by the probe without invalid writes.
4. External agents remain EXTERNAL_AGENT — never ordinary completion models,
   never auto-run, always approval/permission-gated.
5. Big Pickle stays NOT_INTEGRATED; OPENCODE_ZEN_API_KEY is not added.

Founder action (not a code blocker): renew credentials for grok/kimi
(REQUIRES_REAUTH) and resolve quota for openai/deepseek when ready.