/**
 * CodeConClave — unified action planner (Phase F).
 *
 * Turns ONE user objective plus an explicit ordered step list into a validated
 * execution plan over the REAL surface catalogue. The planner does not invent
 * work and does not execute anything:
 *
 *   - each step's surface is resolved with the same `inferSurface` the router
 *     uses (explicit field wins, else instruction kind);
 *   - each step is checked against the LIVE gates (`surfaceEnabled`) — a step
 *     whose surface is disabled is marked BLOCKED with the exact reason, never
 *     silently re-routed (a local-file step is never moved to CLOUD);
 *   - dependencies are validated (in range, no self-edges, no cycles);
 *   - risk/permission requirements are stated per step so the caller (human or
 *     coworker agent) can obtain authorization BEFORE routing.
 *
 * Natural-language understanding stays where it belongs: the AI coworker
 * produces the candidate step list through the existing gateway/tool-call
 * path and submits it here for grounding. `ready` is true only when every
 * step is routable right now.
 */
import { AppError } from '../../shared/errors.js';
import {
  ACTION_SURFACES,
  inferSurface,
  surfaceEnabled,
  type ActionSurface,
} from './contract.js';

export interface PlanStepInput {
  title: string;
  description?: string | null;
  surface?: string;
  deviceId?: string;
  localInstruction?: unknown;
  dependsOn?: number[];
}

export interface PlanObjectiveInput {
  projectId: string;
  objective: string;
  steps: PlanStepInput[];
}

export type StepReadiness = 'READY' | 'BLOCKED';

export interface PlannedStep {
  index: number;
  title: string;
  description: string | null;
  surface: ActionSurface;
  readiness: StepReadiness;
  /** Exact reason when BLOCKED (disabled surface, bad input, bad dependency). */
  blockReason: string | null;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  permissionRequired: string;
  deviceId: string | null;
  dependsOn: number[];
}

export interface ObjectivePlan {
  projectId: string;
  objective: string;
  ready: boolean;
  steps: PlannedStep[];
  warnings: string[];
}

const SURFACE_RISK: Record<ActionSurface, PlannedStep['risk']> = {
  CLOUD: 'LOW',
  LOCAL: 'MEDIUM',
  BROWSER: 'MEDIUM',
  DESKTOP: 'MEDIUM',
  PREVIEW: 'LOW',
};

function permissionFor(surface: ActionSurface, hasDevice: boolean): string {
  switch (surface) {
    case 'CLOUD':
      return 'project membership (cloud execution)';
    case 'LOCAL':
      return hasDevice
        ? 'paired-device ownership + workspace capability grant (file_read/file_write/terminal_exec as used)'
        : 'paired-device ownership + workspace capability grant (no device selected yet)';
    case 'BROWSER':
      return 'paired-device ownership + browser origin grant + approval for consequential ops';
    case 'DESKTOP':
      return 'paired-device ownership + desktop app allow-list + per-action approval for risky ops';
    case 'PREVIEW':
      return 'project membership + preview tooling configuration';
  }
}

function hasCycle(n: number, edges: Map<number, number[]>): boolean {
  const state = new Array<number>(n).fill(0);
  const visit = (v: number): boolean => {
    state[v] = 1;
    for (const w of edges.get(v) ?? []) {
      if (state[w] === 1) return true;
      if (state[w] === 0 && visit(w)) return true;
    }
    state[v] = 2;
    return false;
  };
  for (let i = 0; i < n; i += 1) {
    if (state[i] === 0 && visit(i)) return true;
  }
  return false;
}

/** Validate + ground one objective into an explicit ordered plan. Pure. */
export function planObjective(input: PlanObjectiveInput): ObjectivePlan {
  if (!input.projectId || !input.objective?.trim()) {
    throw AppError.badRequest('invalid_input', 'projectId and a non-empty objective are required');
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw AppError.badRequest('invalid_input', 'at least one plan step is required');
  }
  if (input.steps.length > 50) {
    throw AppError.badRequest('invalid_input', 'a plan holds at most 50 steps');
  }

  const warnings: string[] = [];
  const edges = new Map<number, number[]>();
  const steps: PlannedStep[] = input.steps.map((raw, index) => {
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    const dependsOn = Array.isArray(raw.dependsOn) ? raw.dependsOn.filter((d) => Number.isInteger(d)) : [];
    edges.set(index, dependsOn);

    if (!title) {
      return {
        index, title: '', description: null, surface: 'CLOUD', readiness: 'BLOCKED',
        blockReason: 'step title is required', risk: 'LOW',
        permissionRequired: permissionFor('CLOUD', false),
        deviceId: null, dependsOn,
      };
    }
    // An explicitly named but unknown surface is a caller error — never
    // silently reinterpreted as another surface.
    if (typeof raw.surface === 'string' && !(ACTION_SURFACES as readonly string[]).includes(raw.surface)) {
      return {
        index, title, description: raw.description ?? null, surface: 'CLOUD', readiness: 'BLOCKED',
        blockReason: `unknown surface '${raw.surface.slice(0, 40)}' (supported: ${ACTION_SURFACES.join(', ')})`,
        risk: 'LOW', permissionRequired: permissionFor('CLOUD', false),
        deviceId: null, dependsOn,
      };
    }
    const surface = inferSurface(raw.surface, raw.localInstruction);
    if (!surfaceEnabled(surface)) {
      return {
        index, title, description: raw.description ?? null, surface, readiness: 'BLOCKED',
        blockReason: surface === 'CLOUD'
          ? 'the CLOUD surface is unavailable (unexpected)'
          : `the ${surface} execution surface is disabled on this deployment`,
        risk: SURFACE_RISK[surface], permissionRequired: permissionFor(surface, Boolean(raw.deviceId)),
        deviceId: typeof raw.deviceId === 'string' ? raw.deviceId : null, dependsOn,
      };
    }
    if (raw.deviceId && (surface === 'CLOUD' || surface === 'PREVIEW')) {
      warnings.push(`step ${index + 1} ('${title.slice(0, 60)}') sets a deviceId but the ${surface} surface does not use devices; it will be ignored at routing`);
    }
    if ((surface === 'LOCAL' || surface === 'BROWSER' || surface === 'DESKTOP') && !raw.deviceId) {
      warnings.push(`step ${index + 1} ('${title.slice(0, 60)}') targets ${surface} without a deviceId; select a paired device before routing`);
    }
    return {
      index, title, description: raw.description ?? null, surface, readiness: 'READY',
      blockReason: null, risk: SURFACE_RISK[surface],
      permissionRequired: permissionFor(surface, Boolean(raw.deviceId)),
      deviceId: typeof raw.deviceId === 'string' ? raw.deviceId : null, dependsOn,
    };
  });

  // Dependency validation across the whole plan (range, self-edge, cycles).
  const n = steps.length;
  const badDep = steps.some((s) => s.dependsOn.some((d) => d < 0 || d >= n || d === s.index));
  if (badDep) {
    for (const s of steps) {
      if (s.readiness === 'READY' && s.dependsOn.some((d) => d < 0 || d >= n || d === s.index)) {
        s.readiness = 'BLOCKED';
        s.blockReason = 'dependsOn references an out-of-range step or the step itself';
      }
    }
  } else if (hasCycle(n, edges)) {
    for (const s of steps) {
      if (s.readiness === 'READY') {
        s.readiness = 'BLOCKED';
        s.blockReason = 'dependency cycle detected in plan steps';
      }
    }
  }

  return {
    projectId: input.projectId,
    objective: input.objective.trim(),
    ready: steps.every((s) => s.readiness === 'READY'),
    steps,
    warnings,
  };
}
