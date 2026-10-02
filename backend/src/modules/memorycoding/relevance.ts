/**
 * CodeConClave — PKG-23 Memory-Powered Coding — deterministic relevance.
 *
 * Honest retrieval: CodeConClave ranks memories with a DETERMINISTIC scoring
 * model (same project/workspace/file/module/symbol/task/error/issue,
 * recentness, explicit source). It does NOT claim semantic embeddings model the
 * "meaning" of free text when retrieval is keyword/rule based. This module
 * reports its own mode so callers can present the truth:
 *
 *   MEMORY_RETRIEVAL = DETERMINISTIC (exact signal matches) / HEURISTIC (fuzzy)
 *
 * It composes the existing confidence/contradiction gating in
 * `memory/service.ts` (confidenceGate) rather than bypassing it.
 */
import type { MemoryRow } from '../memory/service.js';
import { MemoryContradictionState } from '@codeconclave/shared';

export type RetrievalMode = 'DETERMINISTIC' | 'HEURISTIC';

export interface RelevanceSignal {
  name: string;
  weight: number;
  hit: boolean;
}

export interface ScoredMemory {
  memory: MemoryRow;
  score: number;
  mode: RetrievalMode;
  signals: RelevanceSignal[];
}

export interface RelevanceContext {
  projectId?: string | null;
  workspaceId?: string | null;
  file?: string | null;
  module?: string | null;
  symbol?: string | null;
  taskId?: string | null;
  error?: string | null;
  issue?: string | null;
  deployment?: string | null;
  teamId?: string | null;
  query?: string | null;
}

const STOP = new Set(['the','a','an','and','or','for','from','of','to','in','on','is','are','with','this','that','it','as','at','by','be','was','were','we','our','use','used','using','file','files','code']);
function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of (text ?? '').toLowerCase().split(/[^a-z0-9_]+/)) {
    if (t.length >= 3 && !STOP.has(t)) out.add(t);
  }
  return out;
}

function contentTokens(m: MemoryRow): Set<string> {
  const t = new Set<string>();
  for (const x of tokens(m.content)) t.add(x);
  if (m.provenance) for (const x of tokens(m.provenance)) t.add(x);
  if (m.structured) {
    for (const v of Object.values(m.structured as Record<string, unknown>)) {
      if (typeof v === 'string') for (const x of tokens(v)) t.add(x);
    }
  }
  return t;
}

/**
 * Score a memory against the current coding context. Deterministic signals get
 * strong weights; query keyword overlap is reported as HEURISTIC (fuzzy).
 */
export function scoreMemory(m: MemoryRow, ctx: RelevanceContext): ScoredMemory {
  const signals: RelevanceSignal[] = [];
  const add = (name: string, weight: number, hit: boolean): void => { if (hit) signals.push({ name, weight, hit }); };

  if (ctx.projectId && m.project_id === ctx.projectId) add('same_project', 30, true);
  if (ctx.teamId && m.team_id === ctx.teamId) add('same_team', 18, true);
  if (ctx.file && m.structured && (m.structured as Record<string, unknown>).file === ctx.file) add('same_file', 40, true);
  if (ctx.module && m.structured && (m.structured as Record<string, unknown>).module === ctx.module) add('same_module', 25, true);
  if (ctx.symbol && m.structured && (m.structured as Record<string, unknown>).symbol === ctx.symbol) add('same_symbol', 35, true);
  if (ctx.taskId && m.task_id === ctx.taskId) add('same_task', 30, true);

  const cTokens = contentTokens(m);
  if (ctx.error) {
    const errT = tokens(ctx.error);
    let shared = 0;
    for (const t of errT) if (cTokens.has(t)) shared += 1;
    if (shared >= 2) add('same_error', 28, true);
  }
  if (ctx.issue) {
    const issT = tokens(ctx.issue);
    let shared = 0;
    for (const t of issT) if (cTokens.has(t)) shared += 1;
    if (shared >= 2) add('same_issue', 28, true);
  }
  if (ctx.deployment && m.provenance && m.provenance.includes(`deploy://${ctx.deployment}`)) add('same_deployment', 22, true);

  // recency: within 7 days strong, within 30 medium
  const created = m.created_at instanceof Date ? m.created_at.getTime() : new Date(m.created_at).getTime();
  const ageDays = (Date.now() - created) / 86400000;
  if (ageDays <= 7) add('recent_7d', 15, true);
  else if (ageDays <= 30) add('recent_30d', 8, true);

  // explicit user-stated memory is preferred
  if (m.source === 'USER_STATED') add('explicit_source', 12, true);

  // run confidence gate: CONFIRMED contradiction = not retrievable
  const BOOST_ONLY = new Set(['recent_7d', 'recent_30d', 'explicit_source']);
  let base = 0;
  let hasContextual = false;
  for (const s of signals) {
    base += s.weight;
    if (!BOOST_ONLY.has(s.name)) hasContextual = true;
  }
  // recency/explicit are BOOSTS, not standalone relevance: without a topical
  // match (or a query) a memory must not rank.
  let score = hasContextual ? base : 0;
  if (score > 0) score += Number(m.confidence ?? 0) * 5;

  let mode: RetrievalMode = 'DETERMINISTIC';
  if (ctx.query) {
    const qT = tokens(ctx.query);
    const cTokens_now = contentTokens(m);
    let shared = 0;
    for (const t of qT) if (cTokens_now.has(t)) shared += 1;
    const frac = qT.size === 0 ? 0 : shared / qT.size;
    if (shared >= 2) {
      // query is itself a topical signal (also applies to boost-only memories)
      score = (score > 0 ? score : base + Number(m.confidence ?? 0) * 5) + shared * 6;
      if (frac >= 0.5) mode = 'HEURISTIC'; // keyword-overlap fuzzy
    }
  }
  // CONFIRMED contradiction: never retrievable regardless of signals
  if (m.contradiction_state === MemoryContradictionState.CONFIRMED) score = 0;
  return { memory: m, score: Math.round(score * 10) / 10, mode, signals };
}

/** Rank an already-windowed set (project-scoped, confidence-gated) by relevance. */
export function rankMemories(items: MemoryRow[], ctx: RelevanceContext, limit = 10): ScoredMemory[] {
  return items
    .map((m) => scoreMemory(m, ctx))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
