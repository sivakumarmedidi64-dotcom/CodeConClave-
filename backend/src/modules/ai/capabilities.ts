/**
 * CodeConClave — model capability matrix (Model Routing 2026).
 *
 * Pure derivation from registry metadata + VERIFIED provider facts. No
 * capability is invented. The five states are kept strictly separate:
 *  - SUPPORTED  = the model's registry/verified capability flags say it can
 *  - CONFIGURED = the provider has an API key on the server
 *  - AVAILABLE  = configured + not DOWN/DEGRADED + entitlement OK
 *  - HEALTHY    = latest provider probe / registry health is HEALTHY
 *  - VERIFIED   = we have verified the provider endpoint exists (Prompt 1 list)
 *
 * This module derives the per-model capability map. The router consumes it.
 */
import type { AiModelDescriptor, CapabilityClass, ModelCapabilities, ProviderId } from '@codeconclave/shared';

/**
 * Canonical capability class (Provider Experience 2026). One truthful label
 * per model, derived from registry facts — never client-invented:
 *  - EXTERNAL_AGENT   capabilityCategory = EXTERNAL_AGENT (out-of-band lifecycle)
 *  - IMAGE_GENERATOR  image_generation/image_editing markers (dedicated image op)
 *  - MULTIMODAL_MODEL accepts IMAGE_INPUT (VISION) for analysis
 *  - NORMAL_MODEL     text/code chat model
 * An image-generation model SHADOWING a text id is impossible: the class is
 * derived from the registry row of the resolved descriptor.
 */
export function capabilityClassOf(model: AiModelDescriptor): CapabilityClass {
  if (model.capabilityCategory === 'EXTERNAL_AGENT') return 'EXTERNAL_AGENT';
  if (model.imageGeneration || model.imageEditing) return 'IMAGE_GENERATOR';
  if (model.supportsVision) return 'MULTIMODAL_MODEL';
  return 'NORMAL_MODEL';
}

/** Provider facts that are VERIFIED from Prompt 1 research. reasoning/coding
 * are honest best-effort classifications derived from the registry's tier,
 * compute class, coding_optimized flag, and capability_category — never
 * fabricated endpoint claims.
 */
export function modelCapabilities(model: AiModelDescriptor): ModelCapabilities {
  const isAgent = model.capabilityCategory === 'EXTERNAL_AGENT';
  const reasoning = model.computeClass !== 'A' || model.tier !== 'EFFICIENT';
  const coding = isAgent || model.codingOptimized || model.computeClass === 'C' || model.tier === 'CAPABLE';
  // Image generation/editing are EXPLICIT registry facts (image_generation /
  // image_editing columns). Never derived from provider id or vision heuristics
  // — a text-only model stays text-only even when a sibling image model exists.
  const imageGeneration = !isAgent && Boolean(model.imageGeneration);
  const imageEditing = !isAgent && Boolean(model.imageEditing);
  return {
    text: true,
    // Devin/Manus are session-lifecycle external agents, not image/reasoning text models:
    reasoning: !isAgent && reasoning,
    coding: !isAgent && coding,
    vision: !isAgent && (model.supportsVision || imageGeneration),
    imageGeneration,
    imageEditing,
    structuredOutput: !isAgent && model.supportsFunctionCalling,
    streaming: !isAgent,
    toolCalling: model.supportsTools,
    autonomousAgent: isAgent,
  };
}

/** Provider base facts keyed by provider id — VERIFIED endpoint identity. */
export const VERIFIED_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>([
  'anthropic',
  'openai',
  'grok',
  'deepseek',
  'kimi',
  'nemotron',
  'north',
  'qwen',
  'gemma',
  'devin',
  'google',
  'ox_alpha',
  'manus',
  'z_code_5_3',
  // Endpoint identity per the official Meta Model API docs
  // (https://dev.meta.ai/docs/protocols/chat-completions: base
  // https://api.meta.ai/v1, POST /chat/completions, Bearer auth, model
  // muse-spark-1.3) plus a live unauthenticated TLS/HTTP probe (host answers
  // HTTP 404 at /v1 without credentials — no billable call). Real-call
  // verification is still pending an authorized smoke test.
  'muse_spark',
]);

/**
 * Providers that are UNVERIFIED (no verifiable endpoint identity). Empty after
 * Prompt 3 verification — every provider above has a legitimate, documented
 * API route. Real-call status (VERIFIED vs ENVIRONMENT_BLOCKED) is tracked
 * separately and honestly (see providerKeySpec.ts / verification docs).
 */
export const UNVERIFIED_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>([]);

/**
 * Whether a model supports every required capability. Pure, unit-tested.
 */
export function supportsRequiredCapabilities(model: AiModelDescriptor, required: Partial<ModelCapabilities>): boolean {
  const caps = modelCapabilities(model);
  const entries = Object.entries(required) as Array<[keyof ModelCapabilities, boolean | undefined]>;
  return entries.every(([key, needed]) => !needed || caps[key]);
}

/** Required capability leaves that a task type maps to (see router). */
export type CapabilityRequirement = Partial<ModelCapabilities>;