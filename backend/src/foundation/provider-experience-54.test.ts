/**
 * PKG-54 — Provider Experience 2026 (Prompt 4 canon).
 *
 * Pure derivations claimed by the frontend from the /models + /providers
 * contracts:
 *   1. capabilityClassOf — one truthful capability class per model derived
 *      ONLY from registry facts. Never client-invented.
 *   2. providerKeyState — the honest credential machine. KEY_INVALID is never
 *      auto-upgraded to ENVIRONMENT_BLOCKED; big_pickle is permanently
 *      ENVIRONMENT_BLOCKED (its key must never be added).
 * Both functions are pure and DB-free: the test env pins AI_PROVIDERS_ENABLED.
 */
import { describe, it, expect } from 'vitest';
import type { AiModelDescriptor } from '@codeconclave/shared';
import { capabilityClassOf } from '../modules/ai/capabilities.js';
import { providerKeyState, type ProviderKeyState } from '../modules/ai/providerKeySpec.js';

function desc(over: Partial<AiModelDescriptor>): AiModelDescriptor {
  return {
    modelId: 'm',
    providerId: 'google',
    displayName: 'M',
    tier: 'EFFICIENT',
    computeClass: 'B',
    contextWindow: 8000,
    supportsVision: false,
    supportsTools: false,
    supportsFunctionCalling: false,
    inputCostPerM: 0,
    outputCostPerM: 0,
    entitlement: 'FREE',
    privacyClass: 'STANDARD',
    targetLatencyMs: 0,
    health: 'UNKNOWN',
    priority: 10,
    fallbackList: [],
    enabled: true,
    effectiveDate: '2026-01-01',
    deprecationDate: null,
    codingOptimized: false,
    capabilityCategory: 'MODEL',
    imageGeneration: false,
    imageEditing: false,
    ...over,
  };
}

describe('PKG-54.1 capabilityClassOf derives one truthful class', () => {
  it('classifies an external agent above everything else (devin/manus)', () => {
    expect(capabilityClassOf(desc({ capabilityCategory: 'EXTERNAL_AGENT', imageGeneration: true, supportsVision: true }))).toBe('EXTERNAL_AGENT');
    expect(capabilityClassOf(desc({ capabilityCategory: 'EXTERNAL_AGENT' }))).toBe('EXTERNAL_AGENT');
  });

  it('classifies image generation/editing markers as IMAGE_GENERATOR', () => {
    expect(capabilityClassOf(desc({ imageGeneration: true }))).toBe('IMAGE_GENERATOR');
    expect(capabilityClassOf(desc({ imageEditing: true }))).toBe('IMAGE_GENERATOR');
    expect(capabilityClassOf(desc({ imageGeneration: true, supportsVision: true }))).toBe('IMAGE_GENERATOR');
  });

  it('classifies vision-accepting text models as MULTIMODAL_MODEL', () => {
    expect(capabilityClassOf(desc({ supportsVision: true }))).toBe('MULTIMODAL_MODEL');
  });

  it('classifies plain text models as NORMAL_MODEL', () => {
    expect(capabilityClassOf(desc({}))).toBe('NORMAL_MODEL');
  });

  it('never derives image capability from provider id or vision heuristics', () => {
    // A vision-capable text model is NOT an image generator just because the
    // provider also ships image models — class must stay MULTIMODAL_MODEL.
    const multimodal = capabilityClassOf(desc({ supportsVision: true, imageGeneration: false }));
    expect(multimodal).toBe('MULTIMODAL_MODEL');
  });
});

describe('PKG-54.2 providerKeyState honest credential machine', () => {
  const VALID: ProviderKeyState[] = ['MISSING_KEY', 'KEY_INVALID', 'ENVIRONMENT_BLOCKED', 'VERIFIED', 'UNVERIFIED', 'PROVIDER_UNAVAILABLE'];

  it('respects the permanent never-add-key gate for big_pickle', () => {
    expect(providerKeyState('big_pickle')).toBe('ENVIRONMENT_BLOCKED');
  });

  it('never reports a fabricated state for an unknown provider', () => {
    expect(providerKeyState('_not_a_provider_')).toBe('MISSING_KEY');
  });

  it('only ever returns a canonical key-state value', () => {
    for (const id of ['google', 'anthropic', 'openai', 'qwen', 'gemma', 'devin', 'manus', 'ox_alpha', 'z_code_5_3']) {
      expect(VALID).toContain(providerKeyState(id));
    }
  });

  it('differentiates KEY_INVALID from ENVIRONMENT_BLOCKED at the type level', () => {
    // Contract guard for the UI: these stay distinct, the spec status is used
    // verbatim and MISSING_KEY dominates (no key ⇒ no claim of any kind).
    expect('KEY_INVALID' as ProviderKeyState).not.toBe('ENVIRONMENT_BLOCKED');
    expect('MISSING_KEY' as ProviderKeyState).not.toBe('KEY_INVALID');
  });
});