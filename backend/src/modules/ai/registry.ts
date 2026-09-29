/**
 * CodeConClave — AI model registry service.
 * Configuration-driven catalogue in PostgreSQL; the server is authoritative
 * for what the client may use (entitlement, health, capabilities).
 */
import { withSystem, pool, queryMany } from '../../shared/db.js';
import { env, enabledProviders } from '../../config/env.js';
import { AppError } from '../../shared/errors.js';
import type { AiModelDescriptor } from '@codeconclave/shared';
import { cache } from '../../shared/cache.js';
import { isProviderVisible } from './gate.js';
import { HEALTH_RETRY_COOLDOWN_MS } from './providers.js';

export interface RegistryRow {
  model_id: string;
  provider_id: string;
  display_name: string;
  tier: string;
  compute_class: string;
  context_window: number;
  supports_vision: boolean;
  supports_tools: boolean;
  supports_function_calling: boolean;
  input_cost_per_m: string | number;
  output_cost_per_m: string | number;
  entitlement: string;
  privacy_class: string;
  target_latency_ms: number;
  health: string;
  priority: number;
  fallback_list: string[];
  enabled: boolean;
  effective_date: string;
  deprecation_date: string | null;
  coding_optimized: boolean;
  capability_category: string;
  image_generation: boolean;
  image_editing: boolean;
}

function toDescriptor(row: RegistryRow): AiModelDescriptor {
  return {
    modelId: row.model_id,
    providerId: row.provider_id as AiModelDescriptor['providerId'],
    displayName: row.display_name,
    tier: row.tier as AiModelDescriptor['tier'],
    computeClass: row.compute_class as AiModelDescriptor['computeClass'],
    contextWindow: row.context_window,
    supportsVision: row.supports_vision,
    supportsTools: row.supports_tools,
    supportsFunctionCalling: row.supports_function_calling,
    inputCostPerM: Number(row.input_cost_per_m),
    outputCostPerM: Number(row.output_cost_per_m),
    entitlement: row.entitlement as AiModelDescriptor['entitlement'],
    privacyClass: row.privacy_class as AiModelDescriptor['privacyClass'],
    targetLatencyMs: row.target_latency_ms,
    health: row.health as AiModelDescriptor['health'],
    priority: row.priority,
    fallbackList: Array.isArray(row.fallback_list) ? row.fallback_list : [],
    enabled: row.enabled,
    effectiveDate: row.effective_date,
    deprecationDate: row.deprecation_date,
    codingOptimized: row.coding_optimized,
    capabilityCategory: (row.capability_category || 'MODEL') as AiModelDescriptor['capabilityCategory'],
    imageGeneration: Boolean(row.image_generation),
    imageEditing: Boolean(row.image_editing),
  };
}

async function loadRegistry(): Promise<AiModelDescriptor[]> {
  const rows = await withSystem<RegistryRow[]>(async (q) =>
    (
      await q.query<RegistryRow>(
        `SELECT model_id, provider_id, display_name, tier, compute_class, context_window,
            supports_vision, supports_tools, supports_function_calling,
            input_cost_per_m, output_cost_per_m, entitlement, privacy_class,
            target_latency_ms, health, priority, fallback_list, enabled,
            effective_date, deprecation_date, coding_optimized, capability_category,
            image_generation, image_editing
         FROM ai_model_registry
         WHERE enabled = true AND (deprecation_date IS NULL OR deprecation_date > CURRENT_DATE)
         ORDER BY priority ASC`,
      )
    ).rows,
  );
  return rows.map(toDescriptor);
}

async function refreshProviderHealth(desc: AiModelDescriptor[]): Promise<AiModelDescriptor[]> {
  const rows = await withSystem<{ provider_id: string; state: string; last_check_at?: string | Date }[]>(async (q) =>
    (
      await q.query<{ provider_id: string; state: string; last_check_at?: string | Date }>(
        'SELECT provider_id, state, last_check_at FROM provider_health',
      )
    ).rows,
  );
  const staleByProvider = new Map<string, boolean>();
  for (const r of rows) {
    const ts = r.last_check_at ? new Date(r.last_check_at).getTime() : 0;
    const healthyRow = r.state === 'HEALTHY' || r.state === 'UP';
    // A failure verdict older than the retry cooldown does not keep the
    // provider excluded forever: it becomes tentatively retryable so the next
    // request re-probes it and (on success) flips it back to HEALTHY.
    staleByProvider.set(
      r.provider_id,
      !healthyRow && Number.isFinite(ts) && ts > 0 && Date.now() - ts > HEALTH_RETRY_COOLDOWN_MS,
    );
  }
  const healthByProvider = new Map(rows.map((r) => [r.provider_id, r.state]));
  return desc.map((d) => {
    const raw = healthByProvider.get(d.providerId);
    let health: AiModelDescriptor['health'];
    if (!raw) health = 'UNKNOWN';
    else if (staleByProvider.get(d.providerId)) health = 'UNKNOWN';
    else if (raw === 'HEALTHY' || raw === 'UP') health = 'HEALTHY';
    else if (raw === 'DEGRADED' || raw === 'RATE_LIMITED') health = 'DEGRADED';
    else health = 'DOWN';
    return { ...d, health };
  });
}

export async function getRegistry(force = false): Promise<AiModelDescriptor[]> {
  const cacheKey = 'ai:registry';
  if (!force) {
    const cached = await cache.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as AiModelDescriptor[];
      } catch {
        /* fall through */
      }
    }
  }
  const registry = await refreshProviderHealth(await loadRegistry());
  await cache.set(cacheKey, JSON.stringify(registry), env.AI_MODEL_REFRESH_MINUTES * 60 * 1000);
  return registry;
}

/**
 * Fail-closed key predicate. A provider key counts as present only when it is
 * a non-blank string (whitespace/empty = absent). In strict mode, placeholder
 * or obviously-invalid shapes (template literals, very short values, generic
 * placeholder words) are treated as absent too — an explicitly broken env must
 * never be reported as configured.
 */
export function isValidProviderKey(value: string | undefined, strict = false): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length === 0) return false;
  if (strict) {
    if (v.length < 8) return false;
    if (/^[<>{}]/.test(v)) return false; // literal template like <API_KEY>
    // eslint-disable-next-line no-control-regex
    if (/^(replace_with|your[_ -]|changeme|x+$|example|todo)/i.test(v)) return false;
  }
  return true;
}

/**
 * Pure provider-configuration parser: a provider is "configured" only when it
 * is on the enabled allow-list AND has a usable API key. Used by
 * `configuredProviders()` and exercised by the provider-key-config tests so the
 * fail-closed parsing can be proven without a database.
 */
export function resolveConfiguredProviders(
  enabled: readonly string[],
  keys: Record<string, string | undefined>,
  opts: { strict?: boolean } = {},
): string[] {
  return enabled.filter((p) => isValidProviderKey(keys[p], opts.strict));
}

/** Providers with a configured API key (honest capability detection). */
export function configuredProviders(): string[] {
  const keyByProvider: Record<string, string | undefined> = {
    anthropic: env.ANTHROPIC_API_KEY,
    openai: env.OPENAI_API_KEY,
    google: env.GEMINI_API_KEY,
    mistral: env.MISTRAL_API_KEY,
    grok: env.GROK_API_KEY,
    deepseek: env.DEEPSEEK_API_KEY,
    kimi: env.KIMI_API_KEY,
    nemotron: env.NVIDIA_API_KEY,
    north: env.COHERE_API_KEY,
    qwen: env.QWEN_API_KEY,
    gemma: env.GEMINI_API_KEY,
    devin: env.DEVIN_API_KEY,
    ox_alpha: env.OX_ALPHA_API_KEY,
    manus: env.MANUS_API_KEY,
    z_code_5_3: env.Z_AI_API_KEY,
  };
  return resolveConfiguredProviders(enabledProviders, keyByProvider).filter(isProviderVisible);
}

/**
 * Server-authoritative model availability for the web + desktop clients
 * (shared /models contract). A model is available ONLY when its provider is
 * configured, the provider is not DOWN/DEGRADED, the user is entitled, and the
 * premium daily budget is not exhausted. The client may not override any leg.
 */
export function computeModelAvailability(opts: {
  configured: boolean;
  health: string;
  computeClass: string;
  entitled: boolean;
  budgetRemaining: number | null;
}): { available: boolean; overBudget: boolean } {
  const overBudget = opts.computeClass === 'C' && opts.budgetRemaining !== null && opts.budgetRemaining <= 0;
  const available =
    opts.configured && opts.health !== 'DOWN' && opts.health !== 'DEGRADED' && opts.entitled && !overBudget;
  return { available, overBudget };
}

export async function getModel(modelId: string): Promise<AiModelDescriptor> {
  const registry = await getRegistry();
  const model = registry.find((m) => m.modelId === modelId);
  if (!model) throw AppError.badRequest('model_not_found', `Model ${modelId} is not in the registry`);
  return model;
}