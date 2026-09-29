# FINAL DISABLED PROVIDER CLEANUP (deferred)

Status-only. No secret values.

## Purpose
Records the safe, deferred cleanup of stale/compromised credentials for disabled AI providers on the Railway backend service. Removal is intentionally deferred because CLI deletion would trigger a Railway redeploy, and the deployment state must remain BLOCKED.

## Decision
- Provider credentials removed via `railway variable delete` would trigger a Railway redeploy (docs: "Variable changes trigger a redeployment by default"; `railway variable delete` has no `--skip-deploys` in CLI 5.43.3).
- Deployment = BLOCKED by policy → do NOT run the deletes now.
- The disabled providers are inert at runtime regardless, because `AI_PROVIDERS_ENABLED=anthropic,openai,google` excludes them (`configuredProviders = enabledProviders.filter(p => keyByProvider[p])`). Their stored values cannot activate.

## Providers deferred (stored but disabled/inert on Railway backend)
| Provider | Variable | Currently disabled | Stale credential should eventually be removed |
|---|---|---|---|
| Cohere | COHERE_API_KEY | YES | YES |
| DeepSeek | DEEPSEEK_API_KEY | YES | YES |
| Grok | GROK_API_KEY | YES | YES |
| Kimi | KIMI_API_KEY | YES | YES |
| Mistral | MISTRAL_API_KEY | YES | YES |
| Nemotron (NVIDIA) | NVIDIA_API_KEY | YES | YES |
| Resend | RESEND_API_KEY | YES | YES |

## Cleanup action (future, when deployment is permitted)
- Run `railway variable delete <KEY> --service backend` for each key above during an authorized window.
- Verify each becomes ABSENT via `railway variable list --service backend`.
- Ensure enabled providers (Anthropic, OpenAI, Google/Gemini), payment config, and runtime infra variables remain untouched.

## Status
- DISABLED_PROVIDER_KEYS = DEFERRED
- REASON = CLI deletion would trigger redeploy
- DEPLOYMENT = STILL_BLOCKED
- ENABLED_PROVIDER_CREDENTIALS = UNCHANGED / READY
