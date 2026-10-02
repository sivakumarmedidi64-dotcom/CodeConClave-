/**
 * CodeConClave — PKG-19 runtime — frontend↔backend runtime correlation (F49).
 * Connects frontend action -> network request -> backend endpoint -> HTTP
 * status / backend error -> likely source -> related recent change. Advisory
 * and evidence-gated: it only surfaces findings derived from captured network
 * events and console errors (never fabricated). When no runtime evidence for a
 * project exists, it reports an honest empty list with UNAVAILABLE state.
 */
import { AppError } from '../../shared/errors.js';
import type { CorrelationFinding } from './types.js';
import { assertProjectAccess } from './security.js';
import { runtimeCaptureEngine } from './capture.js';

/** Optional hook into PKG-17's contextual debug to derive a likely source file. */
export type DebugResolver = (projectId: string, signature: string) => Promise<{ filePath: string | null; hypothesizedCause: string | null }>;

const noopResolver: DebugResolver = async () => ({ filePath: null, hypothesizedCause: null });

/** Heuristic: map an API path segment to a likelier source file hint. */
function likelySourceForPath(path: string): string | null {
  const segs = path.replace(/^\//, '').split('/').filter(Boolean);
  if (segs.length === 0) return null;
  const last = segs[segs.length - 1]!;
  return `src/.../${last}`;
}

export class RuntimeCorrelationEngine {
  constructor(private debugResolver: DebugResolver = noopResolver) {}

  async correlate(userId: string, projectId: string, limit = 100): Promise<{ findings: CorrelationFinding[]; state: 'HEURISTIC' | 'UNAVAILABLE' }> {
    await assertProjectAccess(userId, projectId);
    const [network, consoleEvts] = await Promise.all([
      runtimeCaptureEngine.listNetwork(userId, projectId, limit),
      runtimeCaptureEngine.listConsole(userId, projectId, limit),
    ]);

    const errorSignatures = consoleEvts
      .filter((e) => e.level === 'error' || e.level === 'uncaught')
      .map((e) => `${e.message}${e.stack ? ` ${e.stack}` : ''}`)
      .filter(Boolean);

    if (network.length === 0 && errorSignatures.length === 0) {
      return { findings: [], state: 'UNAVAILABLE' };
    }

    const findings: CorrelationFinding[] = [];
    const failing = network.filter((n) => n.state === 'SERVER_ERROR' || n.state === 'CLIENT_ERROR' || n.state === 'NETWORK_ERROR' || n.state === 'TIMED_OUT');

    for (const n of failing.slice(0, 50)) {
      let backendError: string | null = null;
      let likelySource: string | null = likelySourceForPath(n.urlPath);
      let confidence: CorrelationFinding['confidence'] = 'LOW';

      const matchedConsole = errorSignatures.length > 0 ? errorSignatures[0]! : null;
      if (matchedConsole && n.status && n.status >= 400) {
        backendError = matchedConsole.slice(0, 1000);
        confidence = 'MEDIUM';
        try {
          const d = await this.debugResolver(projectId, matchedConsole);
          if (d.filePath) likelySource = d.filePath;
          if (d.hypothesizedCause && !backendError) backendError = d.hypothesizedCause;
        } catch {
          /* advisory — never break correlation */
        }
      }

      findings.push({
        requestId: n.requestId,
        urlPath: n.urlPath,
        method: n.method,
        frontendState: n.state,
        httpStatus: n.status,
        backendError,
        likelySource,
        relatedChange: backendError ? 'see runtime output / recent file change' : null,
        confidence,
        state: 'HEURISTIC',
      });
    }

    // Also surface console-only errors that have no matching network event.
    for (const sig of errorSignatures.slice(0, 20)) {
      if (findings.some((f) => f.backendError === sig.slice(0, 1000))) continue;
      let likelySource: string | null = null;
      try {
        const d = await this.debugResolver(projectId, sig);
        if (d.filePath) likelySource = d.filePath;
      } catch {
        /* advisory */
      }
      findings.push({
        requestId: null,
        urlPath: '(console)',
        method: 'N/A',
        frontendState: 'CLIENT_ERROR',
        httpStatus: null,
        backendError: sig.slice(0, 1000),
        likelySource,
        relatedChange: 'see runtime output / recent file change',
        confidence: 'LOW',
        state: 'HEURISTIC',
      });
    }

    return { findings, state: 'HEURISTIC' };
  }
}

export const runtimeCorrelationEngine = new RuntimeCorrelationEngine();
