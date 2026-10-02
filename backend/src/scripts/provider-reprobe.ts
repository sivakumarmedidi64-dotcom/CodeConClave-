/**
 * CodeConClave — real provider re-probe (Prompt 6, Part 8).
 * Performs a single tiny real completion per configured provider, records the
 * honest result via updateProviderHealth (provider_health), and prints only
 * safe diagnostics. Never prints keys, tokens, secrets, or headers. Never
 * auto-runs external agents (Manus/Devin are never triggered here).
 */
import { ProviderId } from '@codeconclave/shared';
import { getRegistry } from '../modules/ai/registry.js';
import { getAdapter, updateProviderHealth, ChatRequest, deriveStatusFromFailure } from '../modules/ai/providers.js';
import { AppError } from '../shared/errors.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const EXTERNAL_AGENTS: ReadonlySet<string> = new Set(['manus', 'devin']);
const PROBE_TIMEOUT_MS = 20_000;
const PROBE: ChatRequest = {
  messages: [{ role: 'user', content: 'Reply with exactly the single word: ok' }],
  maxTokens: 8,
  temperature: 0,
};

async function probe(providerId: string, modelId: string): Promise<{ ok: boolean; ms: number; error?: string }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const parts: string[] = [];
  try {
    for await (const chunk of getAdapter(providerId, modelId).complete(PROBE, controller.signal)) {
      parts.push(chunk.delta);
      if (parts.join('').length >= 4 || parts.length >= 3) break;
    }
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: err instanceof AppError ? `${err.errorCode}: ${err.message}` : (err as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function capState(providerId: string): string {
  switch (providerId) {
    case 'manus':
      return 'EXTERNAL_AGENT (task API; never auto-run)';
    case 'devin':
      return 'EXTERNAL_AGENT (enabled; not auto-run)';
    case 'big_pickle':
      return 'NOT_INTEGRATED (no key by rule)';
    default:
      return 'MODEL';
  }
}

const NON_PERSISTED_STATES: ReadonlySet<string> = new Set(['NOT_CONFIGURED', 'LIMITED', 'BLOCKED']);

export async function runReprobe(): Promise<void> {
  const registry = await getRegistry();
  const byProvider = new Map<string, typeof registry>();
  for (const m of registry) {
    const list = byProvider.get(m.providerId) ?? [];
    list.push(m);
    byProvider.set(m.providerId, list);
  }

  const header = 'PROVIDER | MODEL | CONFIGURED | HEALTH | REAL_CALL | ERROR_CLASS | CAPABILITY_STATE';
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const providerId of Object.values(ProviderId)) {
    if ((providerId as string) === 'big_pickle') {
      console.log(`big_pickle | (none) | false | NOT_CONFIGURED | skipped | ENVIRONMENT_BLOCKED | NOT_INTEGRATED`);
      continue;
    }
    const models = (byProvider.get(providerId) ?? []).filter((m) => m.enabled && !m.imageGeneration);
    const model = models[0];
    if (EXTERNAL_AGENTS.has(providerId)) {
      console.log(
        `${providerId} | ${model?.modelId ?? '(none)'} | true | UNVERIFIED | skipped | ENVIRONMENT_BLOCKED | ${capState(providerId)}`,
      );
      continue;
    }
    if (!model) {
      console.log(`${providerId} | (none) | n/a | NOT_CONFIGURED | skipped | NO_REGISTRY_ENTRY | ${capState(providerId)}`);
      continue;
    }
    const result = await probe(providerId, model.modelId);
    const state = result.ok ? 'HEALTHY' : deriveStatusFromFailure(result.error);
    if (!NON_PERSISTED_STATES.has(state)) {
      updateProviderHealth(providerId, result.ok, result.ms, result.ok ? undefined : result.error);
    }
    console.log(
      `${providerId} | ${model.modelId} | true | ${state} | ${result.ok ? 'ok' : 'failed'} | ${
        result.ok ? '-' : classifyForDisplay(result.error)
      } | ${capState(providerId)} (${result.ms}ms)`,
    );
  }
  console.log('REPROBE_POLICY = no secret, token, header, or credential is printed or logged by this probe.');
}

function classifyForDisplay(err: string | undefined): string {
  if (!err) return 'ok';
  const m = err.toLowerCase();
  if (/429|rate limit/.test(m)) return 'rate_limited';
  if (/quota|billing|credit/.test(m)) return 'billing/quota';
  if (/401|403|auth|api[- ]?key|invalid key|credential/.test(m)) return 'invalid_credentials';
  if (/timeout|408|504/.test(m)) return 'timeout';
  if (/not configured/.test(m)) return 'provider_not_configured';
  if (/400|bad request|invalid model|model.*not/.test(m)) return 'bad_request';
  if (/500|502|503|down|unreachable/.test(m)) return 'provider_unavailable';
  return 'provider_unavailable';
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runReprobe()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('reprobe threw:', (err as Error).message);
      process.exit(2);
    });
}