/**
 * CodeConClave — P2 unified action runtime (contract).
 *
 * ONE declarative catalogue of the execution surfaces the coworker can drive —
 * CLOUD, LOCAL (terminal), BROWSER, DESKTOP — with their real feature gate and
 * honest availability. This is the single place the control plane answers the
 * question "which surfaces are actually enabled right now?" so no surface can
 * ever appear enabled when its gate is off.
 *
 * The runtime does not invent a second execution engine: it routes an action to
 * the SAME task fabric (createTaskFromChat) that already runs CLOUD/LOCAL work.
 */
import { env } from '../../config/env.js';

export type ActionSurface = 'CLOUD' | 'LOCAL' | 'BROWSER' | 'DESKTOP' | 'PREVIEW';

/** Execution substrate an action runs on. PREVIEW builds run on the deployment host via the preview service. */
export type ActionExecutionMode = 'CLOUD' | 'LOCAL' | 'PREVIEW';

export interface ActionSurfaceDescriptor {
  surface: ActionSurface;
  title: string;
  description: string;
  /** Execution mode a task for this surface is created with. */
  executionMode: ActionExecutionMode;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  /** Env flag that gates this surface (null = always available). */
  flag: string | null;
}

/** Master gate — default OFF; a disabled runtime must never route actions. */
export function unifiedActionRuntimeEnabled(): boolean {
  return String(env.UNIFIED_ACTION_RUNTIME_ENABLED).toLowerCase() === 'true';
}

export const ACTION_SURFACES: readonly ActionSurface[] = ['CLOUD', 'LOCAL', 'BROWSER', 'DESKTOP', 'PREVIEW'];

const SURFACE_DEFS: Record<ActionSurface, { executionMode: ActionExecutionMode; flag: string | null; title: string; description: string }> = {
  CLOUD: {
    executionMode: 'CLOUD',
    flag: null,
    title: 'Cloud execution',
    description: 'Runs the coworker pipeline in the CodeConClave cloud (always available).',
  },
  LOCAL: {
    executionMode: 'LOCAL',
    flag: 'LOCAL_EXECUTION_ENABLED',
    title: 'Local terminal',
    description: 'Runs shell commands on a paired device inside a granted workspace.',
  },
  BROWSER: {
    executionMode: 'LOCAL',
    flag: 'BROWSER_CONTROL_ENABLED',
    title: 'Browser automation',
    description: 'Drives a managed browser session on a paired device within a granted origin scope.',
  },
  DESKTOP: {
    executionMode: 'LOCAL',
    flag: 'DESKTOP_CONTROL_ENABLED',
    title: 'Desktop control',
    description: 'Enumerates windows and opens/focuses allow-listed apps on a paired device.',
  },
  PREVIEW: {
    executionMode: 'PREVIEW',
    flag: 'LIVE_PREVIEW_ENABLED',
    title: 'Live preview',
    description: 'Builds the project with its validated configuration and serves the running application via the preview service.',
  },
};

function flagEnabled(flag: string | null): boolean {
  if (!flag) return true;
  return String((env as Record<string, unknown>)[flag] ?? '').toLowerCase() === 'true';
}

export interface ActionSurfaceView {
  surface: ActionSurface;
  title: string;
  description: string;
  executionMode: ActionExecutionMode;
  enabled: boolean;
  reason: string;
}

/** The honest, server-derived availability of every execution surface. */
export function listActionSurfaceViews(): ActionSurfaceView[] {
  return ACTION_SURFACES.map((surface) => {
    const def = SURFACE_DEFS[surface];
    const enabled = flagEnabled(def.flag);
    return {
      surface,
      title: def.title,
      description: def.description,
      executionMode: def.executionMode,
      enabled,
      reason: enabled
        ? def.flag
          ? `${def.flag} is enabled`
          : 'always available'
        : `${def.flag} is disabled on this deployment`,
    };
  });
}

export function surfaceExecutionMode(surface: Exclude<ActionSurface, 'PREVIEW'>): 'CLOUD' | 'LOCAL' {
  return SURFACE_DEFS[surface].executionMode as 'CLOUD' | 'LOCAL';
}

export function surfaceEnabled(surface: ActionSurface): boolean {
  return flagEnabled(SURFACE_DEFS[surface].flag);
}

/** Infer the surface a request targets from its explicit field or instruction kind. */
export function inferSurface(explicit: unknown, localInstruction: unknown): ActionSurface {
  if (typeof explicit === 'string' && (ACTION_SURFACES as readonly string[]).includes(explicit)) {
    return explicit as ActionSurface;
  }
  const kind = (localInstruction as { type?: unknown } | null)?.type;
  if (kind === 'browser') return 'BROWSER';
  if (kind === 'desktop') return 'DESKTOP';
  if (kind === 'preview') return 'PREVIEW';
  if (localInstruction !== undefined && localInstruction !== null) return 'LOCAL';
  return 'CLOUD';
}
