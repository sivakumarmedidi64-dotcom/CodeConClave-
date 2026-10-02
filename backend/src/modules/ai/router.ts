/**
 * CodeConClave — intelligent routing engine (Model Routing 2026).
 *
 * ONE routing engine. It sits on top of the existing gateway
 * (routeModels / eligibleModels / completeWithFallback) — it does NOT create a
 * second AI or orchestration system. The router:
 *
 *   user request
 *      ↓ intent classifier (deterministic)
 *      ↓ capability requirements (task type → required caps)
 *      ↓ eligible models (gateway: health, config, entitlement, caps)
 *      ↓ user/workspace policy (preferred model, routing preference, plan)
 *      ↓ cost/latency/quality scoring (preference-aware)
 *      ↓ primary model + fallback chain
 *      ↓ structured decision {taskType, selected, fallbackChain, reason, cost, ...}
 *
 * The reason is concise and explainable. No secrets ever leak into a decision.
 */
import {
  TaskType,
  RoutingPreference,
  type TaskType as TaskTypeType,
  type RoutingPreference as RoutingPreferenceType,
} from '@codeconclave/shared';
import type { AiModelDescriptor, ModelCapabilities } from '@codeconclave/shared';
import { eligibleModels, type RouteOptions } from './gateway.js';
import { modelCapabilities, supportsRequiredCapabilities, type CapabilityRequirement } from './capabilities.js';
import { classifyIntent, type ClassifiedIntent, type IntentSignals } from './intent.js';

export type { ClassifiedIntent, IntentSignals };

export interface RoutingPolicy {
  taskType: TaskTypeType;
  /** Preferred compute class for the workload. */
  computeClass: RouteOptions['computeClass'];
  /** Required capabilities derived from the task type — never invented. */
  requiredCaps: CapabilityRequirement;
  /** Prefer coding-optimized models. */
  coding?: boolean;
  /** Prefer reasoning-capable models. */
  reasoning?: boolean;
  /** Max context tokens needed (e.g. long-context reasoning). */
  minContextTokens?: number;
  /** Allow external agents (Devin) for this task type. */
  allowsExternalAgents?: boolean;
  /** Sensitive task — policy/approval gates apply (no silent switching). */
  sensitive?: boolean;
}

export interface RoutingDecision {
  taskType: TaskTypeType;
  selectedProvider: string;
  selectedModel: string;
  fallbackChain: AiModelDescriptor[];
  reason: string;
  estimatedCost: number | null;
  capabilityMatch: boolean;
  confidence: 'high' | 'medium' | 'low';
  healthState: string;
  routingPreference: RoutingPreferenceType;
  requestedModelHonored: boolean;
  /** True when the requested model was unavailable and the router chose an alternative. */
  requestedModelSubstituted: boolean;
  features: ModelCapabilities;
}

export interface RouteRequest {
  userId: string;
  text?: string;
  taskType?: TaskTypeType;
  /** Explicit capability requirements (e.g. needsVision from an image). */
  requiredCaps?: CapabilityRequirement;
  /** Min context tokens needed (e.g. large memory/context block). Raises the floor. */
  minContextTokens?: number;
  /** Routing preference. AUTO is the recommended default. */
  routingPreference?: RoutingPreferenceType;
  /** Requested model id (user preference) — subject to health/capability/entitlement. */
  requestedModelId?: string;
  /** Optional max context tokens / privacy / plan guardrails. */
  opts?: Omit<RouteOptions, 'requestedModelId' | 'allowExternalAgents'>;
  /** Intent signals for classification (when no explicit taskType). */
  intent?: IntentSignals;
  /** Explicit policy override from coworker/autonomous definitions. */
  policy?: Partial<RoutingPolicy>;
  /** Optionally already-classified intent (coworker paths). */
  classified?: ClassifiedIntent;
  /** Estimated input tokens for cost projection (optional). */
  estimateInputTokens?: number;
}

/** Task-type → routing policy map. Deterministic; no invented capabilities. */
export const TASK_POLICY: Record<TaskTypeType, RoutingPolicy> = {
  GENERAL_CHAT: { taskType: TaskType.GENERAL_CHAT, computeClass: 'B', requiredCaps: {} },
  DEEP_REASONING: { taskType: TaskType.DEEP_REASONING, computeClass: 'C', requiredCaps: {}, reasoning: true, minContextTokens: 64_000 },
  CODING: { taskType: TaskType.CODING, computeClass: 'B', requiredCaps: {}, coding: true },
  CODE_REVIEW: { taskType: TaskType.CODE_REVIEW, computeClass: 'C', requiredCaps: {}, coding: true, reasoning: true },
  DEBUGGING: { taskType: TaskType.DEBUGGING, computeClass: 'B', requiredCaps: {}, coding: true, reasoning: true },
  TEST_GENERATION: { taskType: TaskType.TEST_GENERATION, computeClass: 'B', requiredCaps: {}, coding: true },
  REFACTORING: { taskType: TaskType.REFACTORING, computeClass: 'B', requiredCaps: {}, coding: true },
  ARCHITECTURE: { taskType: TaskType.ARCHITECTURE, computeClass: 'C', requiredCaps: {}, coding: true, reasoning: true, minContextTokens: 64_000 },
  PLANNING: { taskType: TaskType.PLANNING, computeClass: 'C', requiredCaps: {}, reasoning: true },
  DOCUMENTATION: { taskType: TaskType.DOCUMENTATION, computeClass: 'B', requiredCaps: {} },
  SUMMARIZATION: { taskType: TaskType.SUMMARIZATION, computeClass: 'A', requiredCaps: {} },
  MEMORY_RECALL: { taskType: TaskType.MEMORY_RECALL, computeClass: 'A', requiredCaps: {} },
  MEMORY_SYNTHESIS: { taskType: TaskType.MEMORY_SYNTHESIS, computeClass: 'B', requiredCaps: {}, reasoning: true },
  MULTIMODAL_ANALYSIS: {
    taskType: TaskType.MULTIMODAL_ANALYSIS,
    computeClass: 'B',
    requiredCaps: { vision: true },
  },
  IMAGE_GENERATION: {
    taskType: TaskType.IMAGE_GENERATION,
    computeClass: 'B',
    requiredCaps: { imageGeneration: true },
  },
  IMAGE_EDITING: {
    taskType: TaskType.IMAGE_EDITING,
    computeClass: 'B',
    requiredCaps: { imageEditing: true, vision: true },
  },
  AUTONOMOUS_ENGINEERING: {
    taskType: TaskType.AUTONOMOUS_ENGINEERING,
    computeClass: 'C',
    requiredCaps: {},
    allowsExternalAgents: true,
    sensitive: true,
  },
  TOOL_USE: {
    taskType: TaskType.TOOL_USE,
    computeClass: 'B',
    requiredCaps: { toolCalling: true },
    coding: true,
  },
  TERMINAL_EXECUTION: {
    taskType: TaskType.TERMINAL_EXECUTION,
    computeClass: 'B',
    requiredCaps: { toolCalling: true },
    coding: true,
    sensitive: true,
  },
  TASK_PLANNING: { taskType: TaskType.TASK_PLANNING, computeClass: 'C', requiredCaps: {}, reasoning: true },
  BACKGROUND_TASK: { taskType: TaskType.BACKGROUND_TASK, computeClass: 'A', requiredCaps: {} },
  FAST_SIMPLE_QUERY: { taskType: TaskType.FAST_SIMPLE_QUERY, computeClass: 'A', requiredCaps: {} },
} as const;

const CLASS_PRIORITY: Record<string, number> = { C: 3, B: 2, A: 1 };

/**
 * Rank models by routing preference. Pure, unit-tested.
 * - QUALITY: highest compute class first (best capability), then registry priority.
 * - BALANCED/AUTO: registry priority then cost (capability-aware balancing).
 * - FAST: lowest targetLatencyMs among capable.
 * - COST_SAVER: lowest known cost among capable (never drops required caps —
 *   the caller already filtered by capability).
 */
export function rankByPreference(
  candidates: AiModelDescriptor[],
  preference: RoutingPreferenceType,
): AiModelDescriptor[] {
  const copy = [...candidates];
  switch (preference) {
    case RoutingPreference.QUALITY:
      return copy.sort(
        (a, b) =>
          (CLASS_PRIORITY[b.computeClass] ?? 0) - (CLASS_PRIORITY[a.computeClass] ?? 0) ||
          a.priority - b.priority,
      );
    case RoutingPreference.FAST:
      return copy.sort((a, b) => a.targetLatencyMs - b.targetLatencyMs || a.priority - b.priority);
    case RoutingPreference.COST_SAVER:
      return copy.sort(
        (a, b) =>
          a.inputCostPerM - b.inputCostPerM ||
          a.outputCostPerM - b.outputCostPerM ||
          a.priority - b.priority,
      );
    case RoutingPreference.BALANCED:
    case RoutingPreference.AUTO:
    default:
      return copy.sort((a, b) => a.priority - b.priority || a.inputCostPerM - b.inputCostPerM);
  }
}

/** Explainable, concise routing reason. Never exposes secrets or scoring. */
export function reasonFor(
  taskType: TaskTypeType,
  primary: AiModelDescriptor | null,
  requestedModelHonored: boolean,
  requestedModelSubstituted: boolean,
  needsVision: boolean,
  autonomous: boolean,
): string {
  if (!primary) return 'No eligible model satisfies the required capabilities.';
  const name = primary.displayName;
  if (taskType === TaskType.AUTONOMOUS_ENGINEERING || autonomous)
    return `Selected ${name} because autonomous external engineering was requested and this provider is configured.`;
  if (needsVision) return `Selected ${name} because the request requires image/visual analysis.`;
  if (requestedModelHonored) return `Selected ${name} because it is the requested model and satisfies all policy.`;
  if (requestedModelSubstituted)
    return `Requested model unavailable; selected ${name} as the best compliant fallback.`;
  switch (taskType) {
    case TaskType.DEEP_REASONING:
      return `Selected ${name} because this is a deep-reasoning task.`;
    case TaskType.CODING:
      return `Selected ${name} because this is a coding request.`;
    case TaskType.CODE_REVIEW:
      return `Selected ${name} because this is a code-review request.`;
    case TaskType.DEBUGGING:
      return `Selected ${name} because this is a debugging request.`;
    case TaskType.IMAGE_GENERATION:
      return `Selected ${name} because image generation was requested.`;
    case TaskType.SUMMARIZATION:
      return `Selected ${name} because this is a summarization task.`;
    case TaskType.MULTIMODAL_ANALYSIS:
      return `Selected ${name} because the request requires image/visual analysis.`;
    default:
      return `Selected ${name} for a ${taskType} workload.`;
  }
}

const EMPTY_FEATURES: ModelCapabilities = {
  text: false,
  reasoning: false,
  coding: false,
  vision: false,
  imageGeneration: false,
  imageEditing: false,
  structuredOutput: false,
  streaming: false,
  toolCalling: false,
  autonomousAgent: false,
};

/**
 * Build a routing decision WITHOUT executing. Reuses eligibleModels() for
 * health/config/entitlement/capability filtering and applies task-type
 * capability requirements + preference ranking on top.
 */
export async function planRoute(req: RouteRequest): Promise<RoutingDecision> {
  const preference = req.routingPreference ?? RoutingPreference.AUTO;
  const classified: ClassifiedIntent =
    req.classified ?? classifyIntent(req.intent ?? { text: req.text ?? '' });

  const taskType = req.taskType ?? classified.taskType;
  const policy: RoutingPolicy = { ...TASK_POLICY[taskType], ...(req.policy ?? {}) };

  const routeOpts: RouteOptions = {
    ...(req.opts ?? {}),
    requestedModelId: req.requestedModelId ?? undefined,
    computeClass: policy.computeClass,
    coding: policy.coding,
    allowExternalAgents: policy.allowsExternalAgents,
  };
  if (policy.minContextTokens) {
    routeOpts.maxContextTokens = Math.max(routeOpts.maxContextTokens ?? 0, policy.minContextTokens);
  }
  // Memory-aware routing: when the incoming context (memory block, files, plan)
  // is large, raise the context floor so long-context models are kept eligible.
  if (req.minContextTokens) {
    routeOpts.maxContextTokens = Math.max(routeOpts.maxContextTokens ?? 0, req.minContextTokens);
  }

  const eligible = await eligibleModels(req.userId, routeOpts);

  // Capability requirement intersection — honest. Never select a model that
  // lacks a required capability merely because it is cheaper.
  const required = { ...policy.requiredCaps, ...(req.requiredCaps ?? {}) };
  const capable = eligible.filter((m) => supportsRequiredCapabilities(m, required));

  const preferred = req.requestedModelId
    ? capable.find((m) => m.modelId === req.requestedModelId)
    : undefined;
  const requestedModelHonored = preferred !== undefined;
  const requestedModelSubstituted = Boolean(req.requestedModelId) && !requestedModelHonored;

  // An explicitly requested model that satisfies policy is always honored as
  // primary; preference ranking applies to the remaining fallback candidates.
  const rankedCandidates = rankByPreference(capable, preference);
  const ranked = requestedModelHonored
    ? [preferred!, ...rankedCandidates.filter((m) => m.modelId !== preferred!.modelId)]
    : rankedCandidates;

  if (ranked.length === 0) {
    return {
      taskType,
      selectedProvider: '',
      selectedModel: '',
      fallbackChain: [],
      reason: 'No eligible model is available for this task (capability, configuration, health, or entitlement).',
      estimatedCost: null,
      capabilityMatch: false,
      confidence: 'low',
      healthState: 'UNAVAILABLE',
      routingPreference: preference,
      requestedModelHonored: false,
      requestedModelSubstituted,
      features: { ...EMPTY_FEATURES },
    };
  }

  const primary = ranked[0]!;
  const fallbackChain = ranked.length > 1 ? ranked.slice(1, 3) : [primary];
  const estimatedCost =
    req.estimateInputTokens !== undefined
      ? (req.estimateInputTokens / 1_000_000) * primary.inputCostPerM
      : null; // pricing unknown until input length is known — never fabricated

  return {
    taskType,
    selectedProvider: primary.providerId,
    selectedModel: primary.modelId,
    fallbackChain,
    reason: reasonFor(
      taskType,
      primary,
      requestedModelHonored,
      requestedModelSubstituted,
      Boolean(required.vision),
      Boolean(required.autonomousAgent),
    ),
    estimatedCost,
    capabilityMatch: true,
    confidence: requestedModelHonored ? 'high' : ranked.length >= 2 ? 'medium' : 'low',
    healthState: primary.health,
    routingPreference: preference,
    requestedModelHonored,
    requestedModelSubstituted,
    features: modelCapabilities(primary),
  };
}