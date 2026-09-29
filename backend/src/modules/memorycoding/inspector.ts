/**
 * CodeConClave — PKG-23 Memory Inspector.
 *
 * Bounded, paged, filterable read view for the MemoryInspector panel. Returns
 * only metadata + safe summaries (preferences, patterns, bug incidents, links);
 * secrets are redacted at write time and never returned raw. All reads are
 * owner+project scoped.
 */
import { listPreferences, type PrefRow } from './codingRecords.js';
import { listPatterns, listBugIncidents, listMemoryLinks, type PatternRow, type BugIncidentRow, type MemoryLinkRow } from './codingRecords.js';
import { retentionStats, type RetentionStats } from './lifecycle.js';

export interface MemoryInspectorRequest {
  projectId?: string | null;
  category?: 'preferences' | 'patterns' | 'bugs' | 'links' | 'stats' | 'all';
  limit?: number;
}

export interface MemoryInspectorReport {
  stats: RetentionStats;
  preferences: PrefRow[];
  patterns: PatternRow[];
  bugs: BugIncidentRow[];
  links: MemoryLinkRow[];
  summary: {
    activePatterns: number;
    openBugs: number;
    explicitPreferences: number;
    inferredPreferences: number;
  };
}

export async function inspectMemory(
  userId: string,
  req: MemoryInspectorRequest,
): Promise<MemoryInspectorReport> {
  const limit = Math.min(req.limit ?? 50, 100);
  const projectId = req.projectId ?? null;
  const cat = req.category ?? 'all';

  const [prefs, patterns, bugs, links, stats] = await Promise.all([
    cat === 'preferences' || cat === 'all' ? listPreferences(userId, projectId) : Promise.resolve([]),
    cat === 'patterns' || cat === 'all' ? listPatterns(userId, projectId) : Promise.resolve([]),
    cat === 'bugs' || cat === 'all' ? listBugIncidents(userId, projectId ?? undefined) : Promise.resolve([]),
    cat === 'links' || cat === 'all' ? (projectId ? listMemoryLinks(userId, projectId) : Promise.resolve([])) : Promise.resolve([]),
    retentionStats(userId, projectId ?? undefined),
  ]);

  return {
    stats,
    preferences: prefs.slice(0, limit),
    patterns: patterns.slice(0, limit),
    bugs: bugs.slice(0, limit),
    links: links.slice(0, limit),
    summary: {
      activePatterns: patterns.filter((p) => p.status === 'ACTIVE' && p.confidence >= 0.3).length,
      openBugs: bugs.filter((b) => b.status === 'OPEN').length,
      explicitPreferences: prefs.filter((p) => p.classification === 'EXPLICIT').length,
      inferredPreferences: prefs.filter((p) => p.classification === 'INFERRED').length,
    },
  };
}
