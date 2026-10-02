/**
 * CodeConClave — in-process security & operational event metrics (Phase 15).
 * Lightweight named counters and latency aggregates. Values are numbers only —
 * never secrets, paths, or user content. Snapshot is exposed to authorized
 * operators via the diagnostics API and consumed by the health rollup.
 */
const counters = new Map<string, number>();
const latencies = new Map<string, { count: number; totalMs: number }>();

export function incMetric(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function recordLatencyMetric(name: string, ms: number): void {
  const current = latencies.get(name) ?? { count: 0, totalMs: 0 };
  latencies.set(name, { count: current.count + 1, totalMs: current.totalMs + Math.max(0, ms) });
}

/** Snapshot of all counters + average latencies (ms, rounded). Never resets. */
export function metricSnapshot(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of counters) out[k] = v;
  for (const [k, v] of latencies) out[`latency:${k}`] = v.count > 0 ? Math.round(v.totalMs / v.count) : 0;
  return out;
}

/** Test hook only — clears all in-process counters. */
export function resetMetrics(): void {
  counters.clear();
  latencies.clear();
}