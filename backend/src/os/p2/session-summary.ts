/**
 * CodeConClave AI OS — P2.8 Session Summary.
 *
 * Aggregates a P2.3 replay timeline into a concise human-readable session
 * summary: actions attempted, files changed, approvals requested/granted,
 * failures, and final result. It never includes secret fields — values pass
 * through the same sanitizer used by observability.
 */
import { AppError } from '../../shared/errors.js';
import type { ReplayEvent, SessionReplay } from './replay.js';
import type { P2Feature } from './flags.js';

export interface SessionSummary {
  workspaceId: string | null;
  eventCount: number;
  prompts: number;
  toolCalls: number;
  filesChanged: string[];
  approvals: { requested: number; granted: number };
  failures: string[];
  result: string | null;
  durationMs: number | null;
}

export class SessionSummarizer {
  constructor(
    private replay: SessionReplay,
    private feature: () => P2Feature | null,
  ) {}

  isEnabled(): boolean {
    return this.feature() === 'summary';
  }

  summarize(workspaceId: string | null): SessionSummary {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_summary_disabled', 'session summary feature is off');
    const events = this.replay.replay(workspaceId);
    const meta = this.replay.metadata(workspaceId);

    const files = new Set<string>();
    const failures: string[] = [];
    let prompts = 0;
    let toolCalls = 0;
    let approvalsRequested = 0;
    let approvalsGranted = 0;
    let result: string | null = null;

    for (const e of events) {
      switch (e.type) {
        case 'prompt':
          prompts += 1;
          break;
        case 'tool':
          toolCalls += 1;
          break;
        case 'file_change': {
          const p = e.data['path'];
          if (typeof p === 'string') files.add(p);
          break;
        }
        case 'approval':
          if (e.data['state'] === 'requested') approvalsRequested += 1;
          if (e.data['state'] === 'granted') approvalsGranted += 1;
          break;
        case 'failure': {
          const msg = e.data['message'] ?? e.data['errorCode'];
          failures.push(typeof msg === 'string' ? msg : 'unknown failure');
          break;
        }
        case 'result': {
          const r = e.data['summary'];
          if (typeof r === 'string') result = r;
          break;
        }
        default:
          break;
      }
    }

    return {
      workspaceId,
      eventCount: events.length,
      prompts,
      toolCalls,
      filesChanged: [...files],
      approvals: { requested: approvalsRequested, granted: approvalsGranted },
      failures,
      result,
      durationMs: meta.firstAt != null && meta.lastAt != null ? meta.lastAt - meta.firstAt : null,
    };
  }
}

export function summarizeEvents(events: ReplayEvent[]): {
  actions: number;
  files: string[];
  approvals: { requested: number; granted: number };
  failures: number;
} {
  const files = new Set<string>();
  let actions = 0;
  let approvalsRequested = 0;
  let approvalsGranted = 0;
  let failures = 0;
  for (const e of events) {
    actions += 1;
    if (e.type === 'file_change') {
      const p = e.data['path'];
      if (typeof p === 'string') files.add(p);
    }
    if (e.type === 'approval') {
      if (e.data['state'] === 'requested') approvalsRequested += 1;
      if (e.data['state'] === 'granted') approvalsGranted += 1;
    }
    if (e.type === 'failure') failures += 1;
  }
  return { actions, files: [...files], approvals: { requested: approvalsRequested, granted: approvalsGranted }, failures };
}
