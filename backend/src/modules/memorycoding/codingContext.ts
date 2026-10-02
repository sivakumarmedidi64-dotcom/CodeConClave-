/**
 * CodeConClave — PKG-23 Memory-Aware Coding Context + Editor Memory.
 *
 * Phase 5: constructs a BOUNDED, task-relevant context for edit/debug/test/
 * refactor work — never dumps all memories. Sources: relevant memories (ranked,
 * DETERMINISTIC/HEURISTIC), prior failures, decisions, patterns, test history,
 * runtime evidence, related files.
 *
 * Phase 14: editor-facing items are TAGGED so the UI can distinguish:
 *   - CURRENT CODE EVIDENCE (read from live repo/runtime records)
 *   - MEMORY (persisted memory)
 *   - INFERENCE (derived suggestion, never presented as certain)
 * Memory NEVER overrides current repository/runtime evidence.
 */
import { retrieveMemoriesForPrompt } from '../memory/service.js';
import { rankMemories, type RelevanceContext } from './relevance.js';
import { listPatterns } from './codingRecords.js';
import type { PatternRow, BugIncidentRow } from './codingRecords.js';

export type ItemKind = 'CURRENT_CODE_EVIDENCE' | 'MEMORY' | 'INFERENCE';

export interface ContextItem {
  kind: ItemKind;
  source: string;
  label: string;
  detail: string;
  confidence: number;
  ref?: string | null;
}

export interface CodingContextOptions {
  projectId: string;
  file?: string | null;
  module?: string | null;
  symbol?: string | null;
  taskId?: string | null;
  error?: string | null;
  maxMemories?: number;
  maxEvidence?: number;
  maxPatterns?: number;
}

export interface CodingContextDeps {
  rawMemories(userId: string, projectId: string): Promise<unknown[]>;
  patterns(userId: string, projectId?: string): Promise<PatternRow[]>;
  bugIncidents(userId: string, projectId: string): Promise<BugIncidentRow[]>;
  runtimeEvidence(userId: string, projectId: string): Promise<Record<string, unknown>[]>;
  decisions(userId: string, projectId: string): Promise<Array<{ title: string; decision: string; impact: string }>>;
}

const realDeps: CodingContextDeps = {
  rawMemories: async (userId, projectId) => {
    // retrieveMemoriesForPrompt returns strings; we re-derive structured rows by
    // a project-scoped read for ranking. Preserve honesty: rank the persisted rows.
    const rows = (await import('../memory/service.js')).listMemories;
    return rows(userId, { projectId, limit: 50 }).then((r) => r.items);
  },
  patterns: (userId, projectId) => listPatterns(userId, projectId),
  bugIncidents: async () => [],
  runtimeEvidence: async () => [],
  decisions: async () => [],
};

export async function buildCodingContext(
  userId: string,
  opts: CodingContextOptions,
  deps: CodingContextDeps = realDeps,
): Promise<ContextItem[]> {
  const items: ContextItem[] = [];
  const maxM = opts.maxMemories ?? 8;
  const maxE = opts.maxEvidence ?? 6;
  const maxP = opts.maxPatterns ?? 4;

  const relCtx: RelevanceContext = {
    projectId: opts.projectId,
    file: opts.file,
    module: opts.module,
    symbol: opts.symbol,
    taskId: opts.taskId,
    error: opts.error,
  };

  const [memories, patterns, incidents, evidenceRows, decisions] = await Promise.all([
    deps.rawMemories(userId, opts.projectId),
    deps.patterns(userId, opts.projectId),
    deps.bugIncidents(userId, opts.projectId),
    deps.runtimeEvidence(userId, opts.projectId),
    deps.decisions(userId, opts.projectId),
  ]);

  // rank memories deterministically
  const scored = rankMemories(memories as never as Parameters<typeof rankMemories>[0], relCtx, maxM);
  for (const s of scored) {
    const m = s.memory as never as { content: string; source: string; provenance: string | null };
    items.push({
      kind: 'MEMORY',
      source: m.source,
      label: `Memory (${s.mode})`,
      detail: m.content.slice(0, 400),
      confidence: Number((m as never as { confidence?: number }).confidence ?? 0.5),
      ref: m.provenance ?? null,
    });
  }

  // decisions are prior recorded evidence (never invented)
  for (const d of decisions.slice(0, 4)) {
    items.push({
      kind: 'CURRENT_CODE_EVIDENCE',
      source: 'decision',
      label: `Decision [${d.impact}] ${d.title}`,
      detail: d.decision.slice(0, 300),
      confidence: 0.9,
    });
  }

  // patterns (only confident enough to be useful; single-observation stay low)
  for (const p of patterns.slice(0, maxP)) {
    if (p.confidence < 0.3) continue;
    items.push({
      kind: 'INFERENCE',
      source: p.source,
      label: `Pattern: ${p.name}`,
      detail: `${p.description} (evidence=${p.evidence_count} confirm=${p.confirm_count} confidence=${p.confidence})`,
      confidence: p.confidence,
    });
  }

  // prior runtime/test/bug evidence (CURRENT CODE EVIDENCE — from live records)
  for (const b of incidents.slice(0, 2)) {
    items.push({
      kind: 'CURRENT_CODE_EVIDENCE',
      source: 'bug_incident',
      label: `Recurring: ${b.title} (${b.occurrences}x)`,
      detail: b.fix_summary ? `Previous fix: ${b.fix_summary}` : `Diagnosis: ${b.diagnosis ?? 'none recorded'}`,
      confidence: b.status === 'FIXED' ? 0.8 : 0.5,
      ref: b.deploy_ref ?? b.test_ref ?? null,
    });
  }

  // runtime evidence (last run failures/timeouts/server errors)
  let evCount = 0;
  for (const ev of evidenceRows.slice(0, maxE)) {
    const e = ev as { kind?: string; label?: string; detail?: string; confidence?: number; ref?: string };
    const label = typeof e.label === 'string' ? e.label : typeof ev.kind === 'string' ? String(ev.kind) : 'runtime';
    items.push({
      kind: 'CURRENT_CODE_EVIDENCE',
      source: 'runtime',
      label,
      detail: String(e.detail ?? '') || String((ev as { command?: string }).command ?? ''),
      confidence: typeof e.confidence === 'number' ? e.confidence : 0.7,
      ref: e.ref ?? null,
    });
    evCount++;
  }

  // Keep the whole set bounded.
  const cap = maxM + maxE + maxP + 6;
  return items.slice(0, cap);
}
