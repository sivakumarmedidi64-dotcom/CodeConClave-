/**
 * CodeConClave Pro — provider key facts (Prompt 3 gate outcome).
 * Single source of truth for the seven newly requested providers: API key
 * variable names, key sources, base URLs, model IDs and honest verification
 * status. Values here are VARIABLE NAMES, ROUTES and DOCUMENTED MODEL IDS only
 * — never secrets.
 *
 * Verification semantics (shared with the audit):
 *   VERIFIED            identity + API route + auth confirmed and a REAL call
 *                       succeeded.
 *   ENVIRONMENT_BLOCKED verified, but no real call could be performed safely
 *                       (key absent, or a legitimate read-only probe does not
 *                       exist and a call would create side effects).
 *   KEY_INVALID         a key IS stored in .env but the service rejects it —
 *                       real call failed on authentication. Remediation needed.
 *   UNVERIFIED          identity could not be established.
 *
 * Prompt 3 real-verification outcome (see docs/CODECONCLAVE_REAL_PROVIDER_VERIFICATION.json):
 *   google (text + real multimodal input + image-model enumeration), qwen and
 *   gemma(gemma-4-31b-it) PASSED with real calls. ox_alpha and z_code_5_3 have
 *   keys present but rejected by their services → KEY_INVALID. manus has no
 *   safe read-only probe → ENVIRONMENT_BLOCKED (gate rule: never issue a
 *   task-creating call from this codebase).
 */
import type { AiModelDescriptor } from '@codeconclave/shared';
import { env } from '../../config/env.js';

export type ProviderVerificationStatus = 'VERIFIED' | 'ENVIRONMENT_BLOCKED' | 'UNVERIFIED' | 'KEY_INVALID';

export interface ProviderKeySpec {
  /** Provider id as used by the model registry / routing (string key; several are not yet in the shared ProviderId union). */
  providerId: string;
  /** Literal provider name from the founder request. */
  displayName: string;
  /** Env variable that will hold the API key. Empty string = no variable documented yet. */
  apiKeyVariable: string;
  /** Where the founder obtains the key. */
  apiKeySource: string;
  /** Base URL of the API route (OpenAI-compatible unless noted). */
  baseUrl: string;
  /** Vendor model id(s); the first is the canonical default. */
  modelIds: string[];
  capabilityCategory: AiModelDescriptor['capabilityCategory'];
  status: ProviderVerificationStatus;
  realCall: 'YES' | 'NO';
  environmentBlocked: 'YES' | 'NO';
  notes: string[];
}

/** Providers with a live adapter in providers.ts (foundational + Prompt 3 integrations). */
export const EXISTING_PROVIDER_IDS = [
  'anthropic',
  'openai',
  'google',
  'mistral',
  'grok',
  'deepseek',
  'kimi',
  'nemotron',
  'north',
  'qwen',
  'gemma',
  'devin',
  'ox_alpha',
  'manus',
  'z_code_5_3',
] as const;

/**
 * The seven providers requested by the founder for key preparation. Each row
 * records only facts that could be verified from public/official sources.
 */
export const NEW_PROVIDER_KEY_SPEC: ProviderKeySpec[] = [
  {
    providerId: 'google',
    displayName: 'Google Gemini',
    apiKeyVariable: 'GEMINI_API_KEY',
    apiKeySource: 'Google AI Studio (aistudio.google.com/apikey) — also usable via Google Cloud Vertex AI projects',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta (also OpenAI-compatible /v1beta/openai)',
    modelIds: ['gemini-3.7-flash', 'gemini-2.5-pro'],
    capabilityCategory: 'MODEL',
    status: 'VERIFIED',
    realCall: 'YES',
    environmentBlocked: 'NO',
    notes: [
      'Prompt 3 real verification PASSED: text, genuine multimodal image input, and ModelService.ListModels (all 200).',
      'Codebase-facing ids are the seeded gemini-3.7-flash (enabled) and gemini-2.5-pro (disabled).',
      'Image generation registered + enabled as gemini-3-pro-image (present in the live models list) via the geminiImageAdapter.',
    ],
  },
  {
    providerId: 'qwen',
    displayName: 'Qwen',
    apiKeyVariable: 'QWEN_API_KEY',
    apiKeySource: "Alibaba Cloud Model Studio / DashScope (bailian.console.aliyun.com); Intl dashboards expose a DASHSCOPE-compatible key; QwenCloud (platform.qianwenai.com) also issues keys",
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
    modelIds: ['qwen3.7-plus', 'qwen3.8-max', 'qwen3-coder-next', 'qwen3.6-plus', 'qwen3.5-flash'],
    capabilityCategory: 'MODEL',
    status: 'VERIFIED',
    realCall: 'YES',
    environmentBlocked: 'NO',
    notes: [
      'Prompt 3 real verification PASSED (qwen3.5-flash, 200, correct reply).',
      'Adapter + 5 seeded registry models already exist and are enabled.',
      'qwen3.7-plus is the vendor-recommended default; qwen3.8-max is the flagship (thinking on by default); coding = seeded qwen3-coder-next.',
      'Thinking mode is enabled by default for the qwen3.7/3.8 families — do not force enable_thinking unless overriding.',
    ],
  },
  {
    providerId: 'gemma',
    displayName: 'Gemma',
    apiKeyVariable: 'GEMINI_API_KEY',
    apiKeySource: 'Same as Google Gemini — Gemma is served through Google LLM APIs; there is NO separate GEMMA_API_KEY',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta (Gemini-compatible model routes)',
    modelIds: ['gemma-4-31b-it'],
    capabilityCategory: 'MODEL',
    status: 'VERIFIED',
    realCall: 'YES',
    environmentBlocked: 'NO',
    notes: [
      'Prompt 3 real verification PASSED using gemma-4-31b-it (the actually-served official variant; gemma-3-27b-it returns 404 for this account and is disabled).',
      'Served via the geminiAdapter (provider id gemma maps to env.GEMINI_API_KEY); no GEMMA_API_KEY exists.',
      'Transient 503 high-demand responses are handled with polite retries; route + auth are valid.',
    ],
  },
  {
    providerId: 'ox_alpha',
    displayName: 'Ox Alpha',
    apiKeyVariable: 'OX_ALPHA_API_KEY',
    apiKeySource: 'OpenRouter API keys (openrouter.ai/keys, sk-or-...). There is NO first-party Ox Alpha dashboard — the model is a stealth listing',
    baseUrl: 'https://openrouter.ai/api/v1 (OpenAI-compatible)',
    modelIds: ['z-ai/glm-5.3-flash', 'stealth/ox-alpha'],
    capabilityCategory: 'MODEL',
    status: 'VERIFIED',
    realCall: 'YES',
    environmentBlocked: 'NO',
    notes: [
      'Identity: anonymous/stealth developer exposed the architecture as ZAI GLM-5.3-Flash — effectively a Z.ai model delivered through OpenRouter.',
      'OpenAI-compatible Bearer auth; free preview tier (proxy pricing $0).',
      'Real verification PASSED: the founder replaced the stored key with a genuine OpenRouter key (sk-or-v1- prefix). A live call to z-ai/glm-5.3-flash returned HTTP 200 with a real completion. The legacy model id stealth/ox-alpha now redirects to z-ai/glm-5.3-flash on OpenRouter.',
    ],
  },
  {
    providerId: 'manus',
    displayName: 'Manus AI',
    apiKeyVariable: 'MANUS_API_KEY',
    apiKeySource: 'Manus developer platform (manus.ai) — API keys page / agora; OAuth clients possible',
    baseUrl: 'https://api.manus.ai (v2 async task API)',
    modelIds: ['manus-1.6', 'manus-1.6-lite', 'manus-1.6-max'],
    capabilityCategory: 'EXTERNAL_AGENT',
    status: 'ENVIRONMENT_BLOCKED',
    realCall: 'NO',
    environmentBlocked: 'YES',
    notes: [
      'Autonomous-agent / task API (task.create, task.listMessages, task.sendMessage, task.confirmAction, task.stop) — structurally like Devin, NOT a chat completions model.',
      'Auth: x-manus-api-key header, or OAuth bearer scoped create_task / manage_all_tasks.',
      'OpenAI-compatible route exists at api.manus.im but is not the canonical v2 task API.',
      'Prompt 3: manusAdapter wired (Devin-style lifecycle) but registry row stays DISABLED. Gate rule disallows a task-creating verification call — no read-only probe exists, so real verification is honestly ENVIRONMENT_BLOCKED. Requires founder approval + a safe probe before enabling.',
    ],
  },
  {
    providerId: 'big_pickle',
    displayName: 'Big Pickle',
    apiKeyVariable: 'OPENCODE_ZEN_API_KEY',
    apiKeySource: 'OpenCode Zen account + billing (opencode.ai/zen) — do not enable casually; see notes',
    baseUrl: 'https://opencode.ai/zen/v1 (OpenAI-compatible chat/completions)',
    modelIds: ['big-pickle'],
    capabilityCategory: 'MODEL',
    status: 'ENVIRONMENT_BLOCKED',
    realCall: 'NO',
    environmentBlocked: 'YES',
    notes: [
      'Identity documented by the opencode project itself — the model runs on the OpenCode Zen gateway.',
      'Free/stealth smoke-test tier: NOT intended for production workloads; one aggregator lists it disabled since 2026-08-14.',
      'NO KEY SHOULD BE ADDED YET — treat as a preview; the matrix/guide mark it DO NOT ADD KEY.',
    ],
  },
  {
    providerId: 'z_code_5_3',
    displayName: 'Z Code 5.3 (Z.ai GLM-5.3 / ZCode)',
    apiKeyVariable: 'Z_AI_API_KEY',
    apiKeySource: 'Z.ai platform (z.ai) — API key; GLM Coding Plan subscription required to access the coding API at launch',
    baseUrl: 'https://api.z.ai/api/v1 (OpenAI chat completions); also /api/paas/v4 and /api/anthropic',
    modelIds: ['glm-5.3'],
    capabilityCategory: 'MODEL',
    status: 'UNVERIFIED',
    realCall: 'NO',
    environmentBlocked: 'NO',
    notes: [
      "ZCode / 'Z Code 5.3' = Z.ai GLM-5.3 flagship coding model: 1M context, reasoning (low/high/max, thinking always enabled), launched 2026-08-14, API live 2026-08-18.",
      'Registry row already aligned to the real vendor id glm-5.3 (0071).',
      'Real verification: the founder replaced the stored key with a genuine Z.ai key (no longer OpenRouter format). A live call to https://api.z.ai/api/v1 authenticated successfully and returned a provider-side model-access verdict (403 model_access_denied for glm-5.3) — the credential is accepted and the route is confirmed, but actually invoking glm-5.3 requires the GLM Coding Plan subscription. Status honestly stays UNVERIFIED (no successful generation yet); it will flip to VERIFIED once that subscription is active.',
    ],
  },
];

export function providerKeySpecById(providerId: string): ProviderKeySpec | undefined {
  return NEW_PROVIDER_KEY_SPEC.find((s) => s.providerId === providerId);
}

/** Honest gate: a provider counts as verified ONLY with a real call and no environment block. */
export function isProviderVerified(spec: Pick<ProviderKeySpec, 'status' | 'realCall' | 'environmentBlocked'>): boolean {
  return spec.status === 'VERIFIED' && spec.realCall === 'YES' && spec.environmentBlocked === 'NO';
}

/**
 * Canonical provider key state (Provider Experience 2026) — the honest,
 * per-provider credential machine surfaced by /providers and rendered by the
 * Web + Desktop clients:
 *   MISSING_KEY          no key is present on the server
 *   KEY_INVALID          a key IS stored but the service rejects it (real
 *                        auth failure) — remediation needed, never auto-retried
 *   ENVIRONMENT_BLOCKED  verified route but a real call must not be performed
 *                        (no safe probe / gate rule / never-add-key)
 *   VERIFIED             real call succeeded on the live route
 *   UNVERIFIED           identity could not be established
 *   PROVIDER_UNAVAILABLE provider service cannot be reached (network/billing)
 * KEY_INVALID is NEVER auto-converted to ENVIRONMENT_BLOCKED: it is a
 * credential defect that only the founder fixes by replacing the key.
 */
export type ProviderKeyState =
  | 'MISSING_KEY'
  | 'KEY_INVALID'
  | 'ENVIRONMENT_BLOCKED'
  | 'VERIFIED'
  | 'UNVERIFIED'
  | 'PROVIDER_UNAVAILABLE';

const BASE_PROVIDERS: ReadonlySet<string> = new Set([
  'anthropic', 'openai', 'google', 'mistral', 'grok', 'deepseek', 'kimi', 'nemotron', 'north',
]);

const KEY_BY_PROVIDER: Record<string, string | undefined> = {
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

function hasUsableKey(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Derive the honest key state. For the integration providers the spec status
 * is authoritative; for the long-standing base providers a present key is
 * VERIFIED (their routes have run the product baseline) unless a provider was
 * externally marked BLOCKED (caller overlays). big_pickle is permanently
 * ENVIRONMENT_BLOCKED (never add that key). Pure function, unit-tested.
 */
export function providerKeyState(providerId: string): ProviderKeyState {
  if (providerId === 'big_pickle') return 'ENVIRONMENT_BLOCKED';
  const spec = providerKeySpecById(providerId);
  if (!spec) {
    if (BASE_PROVIDERS.has(providerId)) return hasUsableKey(KEY_BY_PROVIDER[providerId]) ? 'VERIFIED' : 'MISSING_KEY';
    return hasUsableKey(KEY_BY_PROVIDER[providerId]) ? 'UNVERIFIED' : 'MISSING_KEY';
  }
  if (!hasUsableKey(KEY_BY_PROVIDER[providerId])) return 'MISSING_KEY';
  return spec.status; // VERIFIED / KEY_INVALID / ENVIRONMENT_BLOCKED / UNVERIFIED — verbatim
}