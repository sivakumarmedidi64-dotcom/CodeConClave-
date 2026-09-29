/**
 * CodeConClave — #44 Hotspot Profiler (PKG-17).
 * Exposes performance hotspots as a ranked developer-workflow surface, consuming
 * the existing performance oracle's `generatePerformanceReport` (slow functions,
 * N+1s, API latency risks) — read-only reuse, never duplicated. All durations
 * are ESTIMATED and advisory.
 */
import { newId } from '../../shared/ids.js';
import { PREFIX } from '../../shared/ids.js';
import { generatePerformanceReport } from '../engineering-intelligence/performanceOracle.js';
import type { HotspotEntry, HotspotProfilerReport } from './types.js';

export async function buildHotspotProfilerReport(
  userId: string,
  projectId: string,
): Promise<HotspotProfilerReport> {
  const report = await generatePerformanceReport(userId, projectId);

  const hotspots: HotspotEntry[] = [];

  for (const s of report.slowFunctions) {
    hotspots.push({
      id: newId(PREFIX.DEVWORKFLOW_HOTSPOT),
      filePath: s.filePath,
      label: s.functionName,
      estimatedDurationMs: s.estimatedDurationMs,
      source: s.source,
      isHotPath: s.estimatedDurationMs >= 100,
      state: 'HEURISTIC',
      evidence: s.reason,
    });
  }

  for (const n of report.nPlusOnes) {
    hotspots.push({
      id: newId(PREFIX.DEVWORKFLOW_HOTSPOT),
      filePath: n.filePath,
      label: n.pattern,
      estimatedDurationMs: n.estimatedQueries * 2,
      source: n.source,
      isHotPath: n.estimatedQueries > 10,
      state: 'HEURISTIC',
      evidence: `${n.loopContext} — ${n.fixSuggestion}`,
    });
  }

  for (const a of report.apiLatencyRisks) {
    hotspots.push({
      id: newId(PREFIX.DEVWORKFLOW_HOTSPOT),
      filePath: a.endpoint,
      label: `${a.method} ${a.endpoint}`,
      estimatedDurationMs: a.estimatedP99Ms,
      source: a.source,
      isHotPath: a.estimatedP99Ms >= 500,
      state: 'HEURISTIC',
      evidence: a.bottlenecks.join('; '),
    });
  }

  hotspots.sort((x, y) => y.estimatedDurationMs - x.estimatedDurationMs);
  const top = hotspots.slice(0, 100);

  return {
    id: newId(PREFIX.DEVWORKFLOW_REPORT),
    projectId,
    generatedAt: new Date().toISOString(),
    hotspots: top,
    totalHotspots: top.length,
    totalEstimatedMs: top.reduce((s, h) => s + h.estimatedDurationMs, 0),
    state: 'HEURISTIC',
    limitations: [
      'All durations are ESTIMATED from static analysis via the performance oracle — not measured.',
      'Only the top-100 ranked hotspots are returned.',
      'Advisory — nothing is changed.',
    ],
  };
}