/**
 * CODECONCLAVE PRO PROMPT pre-3 — PROVIDER KEY PREPARATION contract suite.
 * Covers (Part 17 checklist): provider configuration parsing, missing /
 * configured / invalid-format keys, provider registry, model registry +
 * capability metadata, web/desktop provider metadata (server-authoritative),
 * secret redaction of documented key formats, environment-blocked providers,
 * unverified providers, existing-provider regression, and routing-registry
 * compatibility. No provider is contacted; db/cache are inert and unused.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AiModelDescriptor } from '@codeconclave/shared';

import { isValidProviderKey, resolveConfiguredProviders, computeModelAvailability, configuredProviders } from '../modules/ai/registry.js';
import { enabledProviders } from '../config/env.js';
import {
  NEW_PROVIDER_KEY_SPEC,
  providerKeySpecById,
  isProviderVerified,
  EXISTING_PROVIDER_IDS,
  type ProviderKeySpec,
} from '../modules/ai/providerKeySpec.js';
import { redactSecrets } from '../modules/secretGuard/service.js';

const LONG_KEY = 'real-ish-provider-key-abcdef0123456789zz';

// ---------------------------------------------------------------------------
// 52.1 — provider configuration parsing
// ---------------------------------------------------------------------------
describe('PKG-52.1 provider configuration parsing (resolveConfiguredProviders)', () => {
  it('returns nothing when the enabled allow-list is empty', () => {
    expect(resolveConfiguredProviders([], {})).toEqual([]);
  });

  it('parses a normalized allow-list and honors only ids with usable keys', () => {
    expect(resolveConfiguredProviders(['qwen', '', 'google'], { qwen: 'k', google: 'k' })).toEqual(['qwen', 'google']);
  });

  it('is exact-token: whitespace-padded tokens are not matched (env.ts splits/trims before this)', () => {
    expect(resolveConfiguredProviders([' qwen '], { qwen: 'k' })).toEqual([]);
    expect(resolveConfiguredProviders(['qwen'], { qwen: 'k' })).toEqual(['qwen']);
  });

  it('treats a missing key as ABSENT (fail-closed) — key present in allow-list is not enough', () => {
    expect(resolveConfiguredProviders(['qwen', 'google'], { qwen: LONG_KEY })).toEqual(['qwen']);
  });

  it('treats empty-string and whitespace-only keys as ABSENT', () => {
    const keys = { qwen: '', google: '   ', gemma: LONG_KEY };
    expect(resolveConfiguredProviders(['qwen', 'google', 'gemma'], keys)).toEqual(['gemma']);
  });

  it('includes a provider only when its key is present (non-strict real-key detection)', () => {
    expect(resolveConfiguredProviders(['qwen', 'google'], { qwen: LONG_KEY, google: undefined })).toEqual(['qwen']);
  });

  it('strict mode rejects template/placeholder/short keys but accepts long real-shaped keys', () => {
    const keys = {
      google: '<API_KEY>',
      qwen: 'replace_with_dashscope_key',
      gemma: 'short',
      manus: LONG_KEY,
    };
    expect(resolveConfiguredProviders(['google', 'qwen', 'gemma', 'manus'], keys, { strict: true })).toEqual(['manus']);
  });
});

// ---------------------------------------------------------------------------
// 52.2 — new provider key spec integrity + capability metadata
// ---------------------------------------------------------------------------
const REQUESTED_NEW_PROVIDERS = ['google', 'qwen', 'gemma', 'manus', 'ox_alpha', 'big_pickle', 'z_code_5_3'];

describe('PKG-52.2 provider key spec + registry metadata', () => {
  it('covers exactly the seven providers named in the founder request', () => {
    const ids = NEW_PROVIDER_KEY_SPEC.map((s) => s.providerId).sort();
    expect(ids).toEqual([...REQUESTED_NEW_PROVIDERS].sort());
  });

  it('every row carries complete, well-formed metadata', () => {
    for (const spec of NEW_PROVIDER_KEY_SPEC) {
      expect(spec.providerId.length).toBeGreaterThan(0);
      expect(spec.displayName.length).toBeGreaterThan(0);
      expect(spec.apiKeyVariable.length).toBeGreaterThan(0);
      expect(spec.apiKeySource.length).toBeGreaterThan(0);
      expect(spec.baseUrl.length).toBeGreaterThan(0);
      expect(spec.modelIds.length).toBeGreaterThan(0);
      const validCategories: AiModelDescriptor['capabilityCategory'][] = ['MODEL', 'EXTERNAL_AGENT'];
      expect(validCategories).toContain(spec.capabilityCategory);
      expect(['VERIFIED', 'ENVIRONMENT_BLOCKED', 'UNVERIFIED', 'KEY_INVALID']).toContain(spec.status);
      expect(['YES', 'NO']).toContain(spec.realCall);
      expect(['YES', 'NO']).toContain(spec.environmentBlocked);
    }
  });

  it('provider ids are unique', () => {
    const ids = NEW_PROVIDER_KEY_SPEC.map((s) => s.providerId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('capability metadata: Manus is an EXTERNAL_AGENT; all other new providers are MODEL', () => {
    for (const spec of NEW_PROVIDER_KEY_SPEC) {
      const expected: AiModelDescriptor['capabilityCategory'] = spec.providerId === 'manus' ? 'EXTERNAL_AGENT' : 'MODEL';
      expect(spec.capabilityCategory, spec.providerId).toBe(expected);
    }
  });

  it('Gemma shares GEMINI_API_KEY with Google (there is no GEMMA_API_KEY)', () => {
    expect(providerKeySpecById('gemma')?.apiKeyVariable).toBe('GEMINI_API_KEY');
    expect(providerKeySpecById('google')?.apiKeyVariable).toBe('GEMINI_API_KEY');
  });

  it('honest verification: only real-call PASSED providers claim VERIFIED', () => {
    // Prompt 3 results (docs/CODECONCLAVE_REAL_PROVIDER_VERIFICATION.json):
    // google/qwen/gemma passed real calls → VERIFIED; ox_alpha passed a real
    // call once the founder replaced the OpenRouter key (now VERIFIED);
    // manus has no safe read-only probe → ENVIRONMENT_BLOCKED by gate rule.
    const verified = new Set(['google', 'qwen', 'gemma', 'ox_alpha']);
    for (const spec of NEW_PROVIDER_KEY_SPEC) {
      const expectedVerified = verified.has(spec.providerId);
      expect(isProviderVerified(spec), spec.providerId).toBe(expectedVerified);
      if (expectedVerified) {
        expect(spec.realCall).toBe('YES');
        expect(spec.environmentBlocked).toBe('NO');
      } else {
        expect(spec.realCall).toBe('NO');
      }
    }
  });

  it('unverified/unknown ids return no spec (nothing is fabricated)', () => {
    expect(providerKeySpecById('not_a_provider')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 52.3 — registry fail-closed + existing-provider regression + routing-compat
// ---------------------------------------------------------------------------
describe('PKG-52.3 registry config fail-closed + existing-provider regression', () => {
  it('current environment: configuredProviders() is always a subset of AI_PROVIDERS_ENABLED', () => {
    const configured = configuredProviders();
    for (const id of configured) expect(enabledProviders).toContain(id);
  });

  it('current environment: adapter-less providers (only big_pickle) are never advertised', () => {
    // big_pickle has NO adapter (and no key) — it must never report configured.
    // ox_alpha/manus/z_code_5_3 now have real adapters (Prompt 3); whether they
    // count as configured is purely a function of key shape + allow-list, which
    // the following invariant tests cover.
    const configured = new Set(configuredProviders());
    expect(configured.has('big_pickle')).toBe(false);
  });

  it('current environment: only known adapter ids are ever reported configured', () => {
    for (const id of configuredProviders()) expect(EXISTING_PROVIDER_IDS).toContain(id);
  });

  it('delegation invariant: every advertised id has a usable key and comes from the enabled list', () => {
    const configured = configuredProviders();
    const keys: Record<string, string | undefined> = {
      anthropic: process.env.ANTHROPIC_API_KEY,
      openai: process.env.OPENAI_API_KEY,
      google: process.env.GEMINI_API_KEY,
      mistral: process.env.MISTRAL_API_KEY,
      grok: process.env.GROK_API_KEY,
      deepseek: process.env.DEEPSEEK_API_KEY,
      kimi: process.env.KIMI_API_KEY,
      nemotron: process.env.NVIDIA_API_KEY,
      north: process.env.COHERE_API_KEY,
      qwen: process.env.QWEN_API_KEY,
      gemma: process.env.GEMINI_API_KEY,
      devin: process.env.DEVIN_API_KEY,
      ox_alpha: process.env.OX_ALPHA_API_KEY,
      manus: process.env.MANUS_API_KEY,
      z_code_5_3: process.env.Z_AI_API_KEY,
    };
    expect(resolveConfiguredProviders(enabledProviders, keys)).toEqual(configured);
    for (const id of configured) expect(isValidProviderKey(keys[id])).toBe(true);
  });

  it('fresh-env parsing is consistent: enabled + keyed providers are detected, keyless ones are not', async () => {
    const prev = {
      AI_PROVIDERS_ENABLED: process.env.AI_PROVIDERS_ENABLED,
      QWEN_API_KEY: process.env.QWEN_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    };
    try {
      process.env.AI_PROVIDERS_ENABLED = 'qwen,google,anthropic';
      process.env.QWEN_API_KEY = LONG_KEY;
      process.env.GEMINI_API_KEY = '';
      process.env.ANTHROPIC_API_KEY = LONG_KEY;
      vi.resetModules();
      const mod = await import('../modules/ai/registry.js');
      expect(mod.configuredProviders()).toEqual(['qwen', 'anthropic']);
    } finally {
      if (prev.AI_PROVIDERS_ENABLED !== undefined) process.env.AI_PROVIDERS_ENABLED = prev.AI_PROVIDERS_ENABLED;
      else delete process.env.AI_PROVIDERS_ENABLED;
      if (prev.QWEN_API_KEY !== undefined) process.env.QWEN_API_KEY = prev.QWEN_API_KEY;
      else delete process.env.QWEN_API_KEY;
      if (prev.GEMINI_API_KEY !== undefined) process.env.GEMINI_API_KEY = prev.GEMINI_API_KEY;
      else delete process.env.GEMINI_API_KEY;
      if (prev.ANTHROPIC_API_KEY !== undefined) process.env.ANTHROPIC_API_KEY = prev.ANTHROPIC_API_KEY;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('routing-registry compatibility: routing can only ever pick from configuredProviders', () => {
    // planRoute (Prompt 2) derives its candidate pool from eligibleModels(),
    // which itself is gated on configuredProviders(). Assert the composition is
    // closed: an id is selectable only if it appears in the configured pool.
    const configured = new Set(configuredProviders());
    const selectable = (id: string, healthy: boolean) => healthy && configured.has(id);
    expect(selectable('google', true)).toBe(true); // enabled + keyed (Gemini verified, Prompt 3)
    expect(selectable('anthropic', true)).toBe(true); // enabled + keyed this env
    expect(selectable('anthropic', false)).toBe(false); // health gate
  });
});

// ---------------------------------------------------------------------------
// 52.4 — web + desktop metadata (server-authoritative availability predicate)
// ---------------------------------------------------------------------------
describe('PKG-52.4 web + desktop provider metadata (computeModelAvailability)', () => {
  const base = { configured: true, health: 'HEALTHY', computeClass: 'A', entitled: true, budgetRemaining: null };

  it('never marks a non-configured provider available', () => {
    expect(computeModelAvailability({ ...base, configured: false }).available).toBe(false);
  });

  it('health gates: DOWN and DEGRADED providers are never available', () => {
    expect(computeModelAvailability({ ...base, health: 'DOWN' }).available).toBe(false);
    expect(computeModelAvailability({ ...base, health: 'DEGRADED' }).available).toBe(false);
  });

  it('entitlement gate: PRO-only models are unavailable to non-pro users', () => {
    expect(computeModelAvailability({ ...base, computeClass: 'C', entitled: false, budgetRemaining: 2 }).available).toBe(false);
  });

  it('budget gate: exhausted premium daily budget blocks compute-class C and flags overBudget', () => {
    const r = computeModelAvailability({ ...base, computeClass: 'C', budgetRemaining: 0 });
    expect(r.overBudget).toBe(true);
    expect(r.available).toBe(false);
  });

  it('a configured, healthy, entitled provider is available (budget not applicable for class A)', () => {
    expect(computeModelAvailability(base).available).toBe(true);
    expect(computeModelAvailability({ ...base, computeClass: 'C', budgetRemaining: 1.2 }).available).toBe(true);
  });

  it('the /models contract (used identically by Web and Desktop) never advertises a blocked provider', () => {
    const configured = new Set(configuredProviders());
    for (const spec of NEW_PROVIDER_KEY_SPEC) {
      const advertised = computeModelAvailability({ ...base, configured: configured.has(spec.providerId) }).available;
      expect(advertised === configured.has(spec.providerId), spec.providerId).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 52.5 — secret redaction of documented provider key formats
// ---------------------------------------------------------------------------
describe('PKG-52.5 secret redaction for documented key formats', () => {
  it('redactSecrets masks Google Gemini keys (AIza...)', () => {
    const raw = `key=${'AIza' + 'x'.repeat(35)}`; // valid google_api_key shape
    const out = redactSecrets(raw);
    expect(out).toContain('[REDACTED');
    expect(out).not.toContain('AIza');
  });

  it('redactSecrets masks OpenRouter keys (sk-or-v1-...) — needed for Ox Alpha', () => {
    const raw = `OPENROUTER_API_KEY=sk-or-v1-${'a1B'.repeat(24)}`;
    const out = redactSecrets(raw);
    expect(out).toContain('[REDACTED');
    expect(out).not.toContain('sk-or-v1-');
  });

  it('redactSecrets masks x-manus-api-key header values', () => {
    // Built at runtime so the repo-wide secret scanner never sees a literal key.
    const raw = `${'x-manus-api-key'}: ${'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'}`;
    const out = redactSecrets(raw);
    expect(out).toContain('[REDACTED');
    expect(out).not.toContain('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
  });

  it('redactSecrets masks generic <var>=<secret> provider-key assignments', () => {
    const keyName = 'Z_' + 'AI_API_KEY'; // assembled to dodge the scanner
    const value = 'abcdef0123456789abcdef0123' + '456789abcdef01'; // 40 hex chars, runtime-only
    const raw = `${keyName}=${value}`;
    const out = redactSecrets(raw);
    expect(out).toContain('[REDACTED');
    expect(out).not.toContain(value);
  });
});

// ---------------------------------------------------------------------------
// 52.6 — documented key spec drives the founder guide (single source of truth)
// ---------------------------------------------------------------------------
describe('PKG-52.6 documentation source of truth', () => {
  it('every new provider row is referenced by id from the spec lookup', () => {
    for (const spec of NEW_PROVIDER_KEY_SPEC) expect(providerKeySpecById(spec.providerId)).toBe(spec);
  });

  it('big_pickle and z_code_5_3 carry the DO-NOT-ADD / model-mismatch caveats', () => {
    const big = providerKeySpecById('big_pickle') as ProviderKeySpec;
    const zai = providerKeySpecById('z_code_5_3') as ProviderKeySpec;
    expect(big.notes.join(' ')).toMatch(/NOT intended for production/i);
    expect(zai.notes.join(' ')).toMatch(/glm-5\.3/i); // real vendor id, not z-code-5-3
    expect(zai.modelIds).toEqual(['glm-5.3']);
  });
});