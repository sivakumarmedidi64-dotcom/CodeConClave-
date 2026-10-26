/**
 * Agent Sai Srinivasa Athreya — Cloudflare Worker (the edge detective).
 *
 * This is the "all countries" answer: ONE deploy runs in Cloudflare's 300+
 * cities. A cron keeps popular data warm in the SHARED case file (the same
 * `sai_cache` table in Neon that the main app reads), so a pull from any edge
 * is instantly reusable everywhere. The /healthz page lets you check it's alive.
 *
 * It reuses the backend's real connectors (no DB lock-in, see setSaiCaseFile),
 * so nothing is faked — every warmed answer is a real fetch with its real time.
 *
 * One secret only: DATABASE_URL (your Neon pooled connection string).
 */
import { neon } from '@neondatabase/serverless';
import { runConnector, setSaiCaseFile } from '../../backend/dist/modules/sai/connectors.js';

interface Env {
  DATABASE_URL?: string;
  [key: string]: string | undefined;
}

// Popular answers kept warm at the edge, into the shared case file.
const WARM: Array<[string, string]> = [
  ['usgs-earthquakes', ''],
  ['coingecko', 'bitcoin ethereum'],
  ['nasa-eonet', ''],
  ['satellite-position', ''],
  ['open-meteo', 'Mumbai'],
  ['open-meteo', 'New York'],
  ['open-meteo', 'Singapore'],
  ['open-meteo', 'Sydney'],
  ['open-meteo-air-quality', 'Delhi'],
  ['frankfurter', 'USD INR'],
  ['hacker-news-api', ''],
  ['github', 'ai'],
  ['blockchain-info', ''],
  ['wikipedia-on-this-day', ''],
  ['launch-library', ''],
  ['world-bank-api', 'IN:NY.GDP.MKTP.CD'],
];
let idx = 0;
const BATCH = 4;

/** Wire the connectors' shared case file (L2) to Neon over HTTP; collect writes. */
function wireNeon(databaseUrl: string): Array<Promise<unknown>> {
  const sql = neon(databaseUrl);
  const writes: Array<Promise<unknown>> = [];
  setSaiCaseFile({
    read: async (key: string) => {
      try {
        const rows = (await sql`SELECT evidence, stored_at, expires_at FROM sai_cache WHERE cache_key = ${key}`) as Array<{
          evidence: unknown;
          stored_at: string;
          expires_at: string;
        }>;
        const row = rows[0];
        if (!row) return null;
        const expires = new Date(row.expires_at).getTime();
        if (Date.now() >= expires) return null;
        return { evidence: row.evidence as never, storedAt: new Date(row.stored_at).getTime(), expires };
      } catch {
        return null;
      }
    },
    write: (key, sourceId, query, evidence, storedAtMs, expiresMs) => {
      writes.push(
        sql`INSERT INTO sai_cache (cache_key, source_id, query, evidence, region, stored_at, expires_at)
            VALUES (${key}, ${sourceId}, ${query}, ${JSON.stringify(evidence)}, 'edge', to_timestamp(${storedAtMs / 1000}), to_timestamp(${expiresMs / 1000}))
            ON CONFLICT (cache_key) DO UPDATE
              SET evidence = EXCLUDED.evidence, region = EXCLUDED.region, stored_at = EXCLUDED.stored_at, expires_at = EXCLUDED.expires_at`.catch(
          () => undefined,
        ),
      );
    },
  });
  return writes;
}

export default {
  // Cron: warm a small batch of popular data into the shared case file.
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }): Promise<void> {
    // Make the Worker's vars/secrets visible to the connectors' keyEnv().
    for (const k of Object.keys(env)) if (typeof env[k] === 'string') process.env[k] = env[k] as string;
    if (!env.DATABASE_URL) return; // nothing to share until the secret is set
    const writes = wireNeon(env.DATABASE_URL);
    const batch: Array<[string, string]> = [];
    for (let i = 0; i < BATCH; i++) batch.push(WARM[(idx + i) % WARM.length]!);
    idx = (idx + BATCH) % WARM.length;
    for (const [id, query] of batch) {
      try {
        await runConnector(id, query, true); // force a fresh pull → writes into the shared case file
      } catch {
        /* honest skip — a down source is never fatal, never faked */
      }
    }
    ctx.waitUntil(Promise.allSettled(writes));
  },

  // Health check (for you + an uptime pinger). Never exposes secrets.
  async fetch(_req: Request, env: Env): Promise<Response> {
    const body = {
      ok: true,
      agent: 'Agent Sai Srinivasa Athreya',
      edge: true,
      databaseConfigured: Boolean(env.DATABASE_URL),
      time: new Date().toISOString(),
    };
    return new Response(JSON.stringify(body, null, 2), { headers: { 'content-type': 'application/json' } });
  },
};
