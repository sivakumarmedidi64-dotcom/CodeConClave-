/**
 * CodeConClave — PKG-19 runtime — service (capability report).
 * Honest, deterministic capability report for the Browser + Runtime Development
 * package. Execution is enabled only when the sandbox allow-list + workspace are
 * configured; console/network capture readiness reflects there being a preview
 * runtime that CAN forward evidence (VERIFIED_READY when preview is configured,
 * UNAVAILABLE otherwise) — never a claim that live browser data is flowing.
 */
import { env } from '../../config/env.js';
import { executionConfigured } from './runner.js';
import { RuntimeCapabilities } from './types.js';

export interface RuntimeCapabilityReport {
  capabilities: RuntimeCapabilities;
  anchors: string[];
  limitations: string[];
}

export function getRuntimeCapabilities(): RuntimeCapabilityReport {
  const executionEnabled = executionConfigured() && Boolean(env.PREVIEW_PROJECTS_ROOT);
  const previewConfiguredValue = env.PREVIEW_BUILD_ENABLED === 'true' && Boolean(env.PREVIEW_BUILD_COMMAND);
  const captureConsole = previewConfiguredValue ? 'VERIFIED_READY' : 'UNAVAILABLE';
  const captureNetwork = previewConfiguredValue ? 'VERIFIED_READY' : 'UNAVAILABLE';

  return {
    anchors: ['F34', 'F90', 'F38', 'F49'],
    capabilities: {
      executionEnabled,
      backgroundEnabled: executionEnabled,
      consoleCapture: captureConsole,
      networkCapture: captureNetwork,
      verificationEnabled: env.RUNTIME_VERIFY_ENABLED === 'true',
      smokeEnabled: Boolean(env.RUNTIME_SMOKE_CONFIG || env.RUNTIME_SMOKE_BASE_URL),
      browserRuntime: previewConfiguredValue ? 'PREVIEW_IFRAME' : 'NONE',
    },
    limitations: [
      'Execution runs only commands allow-listed in the sandbox; otherwise BLOCKED (never a fake success).',
      'There is no headless browser on this deployment; console/network capture is evidence-only and stays empty until a live preview iframe forwards real events.',
      'Runtime verification/smoke targets depend on configured URLs/ports; absent targets are reported NOT_RUN/UNAVAILABLE, never PASS.',
      'Stopping a background task is best-effort (cancellation requested); the sandbox enforces its own hard timeout.',
      'Correlation is advisory heuristics derived from captured evidence.',
    ],
  };
}

export const runtimeCapabilities = getRuntimeCapabilities;
