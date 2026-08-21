/**
 * CodeConClave — AI model registry service.
 * Configuration-driven catalogue in PostgreSQL; the server is authoritative
 * for what the client may use (entitlement, health, capabilities).
 */
import { pool, queryMany } from '../../shared/db.js';
import { env, enabledProviders } from '../../config/env.js';
import { AppError } from '../../shared/errors.js';
import type { AiModelDescriptor } from '@codeconclave/shared';
import { cache } from '../../shared/cache.js';

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
  };
}

async function loadRegistry(): Promise<AiModelDescriptor[]> {
  const rows = await queryMany<RegistryRow>(
    `SELECT model_id, provider_id, display_name, tier, compute_class, context_window,
            supports_vision, supports_tools, supports_function_calling,
            input_cost_per_m, output_cost_per_m, entitlement, privacy_class,
            target_latency_ms, health, priority, fallback_list, enabled,
            effective_date, deprecation_date, coding_optimized
     FROM ai_model_registry
     WHERE enabled = true AND (deprecation_date IS NULL OR deprecation_date > CURRENT_DATE)
     ORDER BY priority ASC`,
  );
  return rows.map(toDescriptor);
}

async function refreshProviderHealth(desc: AiModelDescriptor[]): Promise<AiModelDescriptor[]> {
  const rows = await queryMany<{ provider_id: string; state: string }>(
    'SELECT provider_id, state FROM provider_health',
  );
  const healthByProvider = new Map(rows.map((r) => [r.provider_id, r.state]));
  return desc.map((d) => ({
    ...d,
    health: (healthByProvider.get(d.providerId) as AiModelDescriptor['health']) ?? 'UNKNOWN',
  }));
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
  };
  return enabledProviders.filter((p) => keyByProvider[p]);
}

export async function getModel(modelId: string): Promise<AiModelDescriptor> {
  const registry = await getRegistry();
  const model = registry.find((m) => m.modelId === modelId);
  if (!model) throw AppError.badRequest('model_not_found', `Model ${modelId} is not in the registry`);
  return model;
}