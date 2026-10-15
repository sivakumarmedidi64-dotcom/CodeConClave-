/**
 * CodeConclave — Agent Sai Srinivasa Athreya · continuous watch loop.
 * Runs inside the worker process (cloud, always-on while deployed):
 * every minute, hash-checks all 29 sources and writes decisions DIRECTLY
 * to ingest_runs + audit via persistDecision — no HTTP round-trip.
 * Ownership preserved: single pinned owner + project (private agent).
 * Missing IDs = loop stays idle and loud, never writes ownerless rows.
 */
import { withTenant } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { AGENT_NAME, INGEST_SOURCES } from '../modules/ingest/sources.js';
import {
  UPSTREAM_TICK_MS,
  fetchRemoteHead,
  persistDecision,
  tickSources,
  type RemoteHead,
  type SourceState,
} from '../modules/ingest/service.js';

const OWNER_ENV = 'INGEST_AGENT_OWNER_ID';
const PROJECT_ENV = 'INGEST_AGENT_PROJECT_ID';

function cfg(): { owner: string; project: string; dna: string; tier: string } | null {
  const owner = (process.env[OWNER_ENV] ?? '').trim();
  const project = (process.env[PROJECT_ENV] ?? '').trim();
  if (!owner || !project) return null;
  return {
    owner,
    project,
    dna: (process.env.INGEST_DNA_VERSION ?? 'v1').trim() || 'v1',
    tier: (process.env.INGEST_TIER ?? 'standard').trim() || 'standard',
  };
}

async function loadStates(owner: string, project: string, dna: string, tier: string): Promise<SourceState[]> {
  const saved = await withTenant(owner, async (q) => {
    const r = await q
      .query(
        `SELECT DISTINCT ON (source_id) source_id, to_hash AS last_hash
         FROM ingest_runs WHERE project_id = $1 ORDER BY source_id, created_at DESC`,
        [project],
      )
      .catch(() => ({ rows: [] as Array<{ source_id: string; last_hash: string | null }> }));
    return (r as { rows: Array<{ source_id: string; last_hash: string | null }> }).rows;
  }).catch(() => []);
  const byId = new Map((saved ?? []).map((s) => [s.source_id, s.last_hash]));
  return INGEST_SOURCES.map((s) => ({
    sourceId: s.id,
    lastHash: byId.get(s.id) ?? null,
    lastDna: dna,
    lastTier: tier,
    repairCount: 0,
  }));
}

export async function runIngestTickOnce(): Promise<{ pulls: number; blocked: number }> {
  const c = cfg();
  if (!c) {
    logger.warn('ingest.watch_idle', { agent: AGENT_NAME, reason: 'owner_or_project_unpinned' });
    return { pulls: 0, blocked: 0 };
  }
  const states = await loadStates(c.owner, c.project, c.dna, c.tier);
  const remotes: RemoteHead[] = [];
  for (const s of INGEST_SOURCES) {
    if (s.kind === 'arxiv') await new Promise((r) => setTimeout(r, 3000));
    remotes.push(await fetchRemoteHead(s, c.dna, c.tier));
  }
  const decisions = tickSources(states, remotes);
  for (const d of decisions) {
    const st = states.find((s) => s.sourceId === d.sourceId);
    const rm = remotes.find((r) => r.sourceId === d.sourceId);
    await persistDecision({
      userId: c.owner,
      projectId: c.project,
      sourceId: d.sourceId,
      action: d.action,
      reason: d.reason,
      fromHash: st?.lastHash ?? null,
      toHash: rm?.revisionHash ?? null,
    });
  }
  const pulls = decisions.filter((d) => d.action === 'PULL').length;
  const blocked = decisions.filter((d) => d.action === 'BLOCKED' || d.action === 'UNKNOWN').length;
  logger.info('ingest.tick', { agent: AGENT_NAME, pulls, blocked });
  return { pulls, blocked };
}

export function startIngestWatch(): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      await runIngestTickOnce();
    } catch (err) {
      logger.warn('ingest.tick_failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (!stopped) timer = setTimeout(tick, UPSTREAM_TICK_MS);
    }
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
