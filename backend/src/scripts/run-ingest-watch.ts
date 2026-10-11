/**
 * CodeConClave — Agent Sai Srinivasa Athreya · watch CLI.
 * Minute-tick entry point a scheduler invokes. Metadata HEAD checks only,
 * never a full download. Mirrors run-watchtower.ts contract:
 *   exit 0 — tick ran, no BLOCKED sources
 *   exit 1 — tick ran, one or more BLOCKED/UNKNOWN (fail-loud, still scanned all)
 *   exit 2 — operational failure before/while running
 * Machine-readable stdout:
 *   INGEST_SOURCES  number of sources checked (>=1)
 *   INGEST_PULLS     number of PULL decisions (0..1 by Dispatch rule)
 *   INGEST_BLOCKED   true / false
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { INGEST_SOURCES, AGENT_NAME } from '../modules/ingest/sources.js';
import { fetchRemoteHead, tickSources, type TickDecision } from '../modules/ingest/service.js';
import { pool } from '../shared/db.js';

export async function runIngestWatch(
  dnaVersion = 'v1',
  tier = 'standard',
): Promise<{ pulls: number; blocked: number; decisions: TickDecision[] }> {
  const remotes = [];
  for (const s of INGEST_SOURCES) {
    remotes.push(await fetchRemoteHead(s, dnaVersion, tier));
  }
  const states = INGEST_SOURCES.map((s) => ({
    sourceId: s.id,
    lastHash: null as string | null,
    lastDna: dnaVersion,
    lastTier: tier,
    repairCount: 0,
  }));
  const decisions = tickSources(states, remotes);
  return {
    pulls: decisions.filter((d) => d.action === 'PULL').length,
    blocked: decisions.filter((d) => d.action === 'BLOCKED' || d.action === 'UNKNOWN').length,
    decisions,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const dna = process.argv[2] ?? 'v1';
  const tier = process.argv[3] ?? 'standard';
  const verbose = process.argv.includes('--verbose');
  runIngestWatch(dna, tier)
    .then(async ({ pulls, blocked, decisions }) => {
      process.stdout.write(`[${AGENT_NAME}] tick complete\n`);
      process.stdout.write(`INGEST_SOURCES=${INGEST_SOURCES.length}\n`);
      process.stdout.write(`INGEST_PULLS=${pulls}\n`);
      process.stdout.write(`INGEST_BLOCKED=${blocked > 0 ? 'true' : 'false'}\n`);
      if (verbose) {
        for (const d of decisions) {
          process.stdout.write(`SOURCE ${d.sourceId} ${d.action} ${d.reason}\n`);
        }
      }
      try {
        await pool.end();
      } finally {
        process.exitCode = blocked > 0 ? 1 : 0;
      }
    })
    .catch(async (err) => {
      process.stderr.write(`[ingest-watch] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      try {
        await pool.end();
      } finally {
        process.exitCode = 2;
      }
    });
}
