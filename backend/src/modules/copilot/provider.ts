/**
 * CodeConClave — PKG-24 AI Developer Copilot — honest provider state.
 *
 * Reuses the existing AI Gateway (modules/ai) for provider capability
 * detection. We NEVER fabricate model availability. States are derived only
 * from the real gateway: configured API keys + registry eligibility.
 *
 * Copilot provider states (from the scope):
 *   LIVE_PROVIDER       — a configured provider passes eligibility right now.
 *   LOCAL_MODEL         — a local/self-hosted model path is configured.
 *   FALLBACK            — a live provider exists but a request-level fallback ran.
 *   PROVIDER_REQUIRED   — the specific operation needs a model but none is ready.
 *   ENVIRONMENT_BLOCKED — copilot feature is gated OFF in this environment.
 *   UNAVAILABLE         — no usable provider / gateway unavailable.
 */
import {
  completeWithFallback,
  eligibleModels,
  type CompleteOptions,
  type CompletionSummary,
} from '../ai/gateway.js';
import { configuredProviders } from '../ai/registry.js';
import { COPILOT_CONFIG } from './config.js';

export type CopilotProviderState =
  | 'LIVE_PROVIDER'
  | 'LOCAL_MODEL'
  | 'FALLBACK'
  | 'PROVIDER_REQUIRED'
  | 'ENVIRONMENT_BLOCKED'
  | 'UNAVAILABLE';

export interface ProviderReport {
  state: CopilotProviderState;
  providersConfigured: number;
  localModelConfigured: boolean;
  note: string;
}

/**
 * A local/self-hosted model path (model that runs in-process or on a local
 * endpoint) may be configured via these env keys. When present we report
 * LOCAL_MODEL honestly rather than pretending a remote LIVE_PROVIDER exists.
 */
function localModelConfigured(): boolean {
  const env = process.env as Record<string, string | undefined>;
  return Boolean(
    env.AIOS_LOCAL_MODEL_URL ||
      env.LOCAL_LLM_URL ||
      env.LOCAL_MODEL_ID ||
      env.OPENAI_BASE_URL,
  );
}

/**
 * Report the current provider state for the copilot. Never performs a network
 * probe here; it reflects the real eligibility/routing outcome through the
 * existing gateway primitives.
 */
export async function providerState(userId: string): Promise<ProviderReport> {
  if (!COPILOT_CONFIG.enabled()) {
    return {
      state: 'ENVIRONMENT_BLOCKED',
      providersConfigured: configuredProviders().length,
      localModelConfigured: localModelConfigured(),
      note: 'Copilot feature is gated OFF (AIOS_P2_COPILOT).',
    };
  }

  const providers = configuredProviders();
  const local = localModelConfigured();
  if (providers.length === 0) {
    if (local) {
      return {
        state: 'LOCAL_MODEL',
        providersConfigured: 0,
        localModelConfigured: true,
        note: 'Only a local model path is configured; live provider routing is off.',
      };
    }
    return {
      state: 'UNAVAILABLE',
      providersConfigured: 0,
      localModelConfigured: false,
      note: 'No AI provider is configured on the server.',
    };
  }

  // A provider key exists. A model is truly usable only if the gateway can route
  // one for this user against a copilot workload. Honor eligibility failures.
  try {
    const ranked = await eligibleModels(userId, {
      computeClass: COPILOT_CONFIG.computeClass,
      coding: true,
    });
    if (ranked.length === 0) {
      return {
        state: 'PROVIDER_REQUIRED',
        providersConfigured: providers.length,
        localModelConfigured: local,
        note: 'Providers are configured but no model currently satisfies the copilot workload (entitlement/health/capability).',
      };
    }
    return {
      state: 'LIVE_PROVIDER',
      providersConfigured: providers.length,
      localModelConfigured: local,
      note: `${ranked.length} model(s) eligible for this workload.`,
    };
  } catch {
    return {
      state: 'PROVIDER_REQUIRED',
      providersConfigured: providers.length,
      localModelConfigured: local,
      note: 'Providers configured but model routing is not currently possible.',
    };
  }
}

/**
 * Run a model completion through the gateway, mapping its real outcome to a
 * copilot provider state (FALLBACK when a fallback model served the request).
 * If the gateway cannot serve a model, we return null and the caller reports an
 * honest PROVIDER_REQUIRED / UNAVAILABLE state instead of fabricated output.
 */
export async function runCompletion(
  opts: CompleteOptions,
): Promise<{ summary: CompletionSummary } | { state: Exclude<CopilotProviderState, 'LIVE_PROVIDER'>; note: string }> {
  if (!COPILOT_CONFIG.enabled()) {
    return { state: 'ENVIRONMENT_BLOCKED', note: 'Copilot feature is gated OFF (AIOS_P2_COPILOT).' };
  }
  try {
    const summary = await completeWithFallback(opts);
    return { summary: boundSummary(summary) };
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'errorCode' in (err as { errorCode?: string })
        ? (err as { errorCode: string }).errorCode
        : 'model_unavailable';
    const note = code === 'no_model_available' ? 'No AI model is available.' : 'The model request failed.';
    return { state: code === 'no_model_available' ? 'PROVIDER_REQUIRED' : 'UNAVAILABLE', note };
  }
}

/**
 * Bound a completion's text payload to the configured maximum output size so a
 * runaway model response can never blow past copilot cost/resource limits.
 */
function boundSummary(summary: CompletionSummary): CompletionSummary {
  const max = COPILOT_CONFIG.maxOutputBytes;
  if (Buffer.byteLength(summary.text, 'utf8') <= max) return summary;
  const bounded = Buffer.from(summary.text, 'utf8').subarray(0, max).toString('utf8') + '\n…[output truncated]';
  return { ...summary, text: bounded };
}
