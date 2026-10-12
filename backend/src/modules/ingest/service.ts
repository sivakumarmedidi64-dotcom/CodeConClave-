/**
 * CodeConClave — Agent Sai Srinivasa Athreya · ingest service.
 * PRIVATE single-owner agent. Diamond wiring: Cache hit → Intake →
 * Route·scout → Dispatch·maker (one source per tick, winner runs) →
 * Gate·sentinel (0 tokens) → Verify·judge → Act → Commit·seal.
 * Every stage writes the Ledger.
 * Upstream tick = metadata hash check ONLY (every minute) — HuggingFace
 * repos change weekly, per-second polling would be rate-limited and banned.
 * Per-second PUSH goes the other way: this service streams tick results +
 * heartbeats to the owner over SSE (see routes.ts /stream).
 * Modalities: every source stores TEXT records + IMAGE payloads (sha256,
 * Gate-checked) in ingest_media.
 */
import { createHash } from 'node:crypto';
import {
  AGENT_NAME,
  ALLOWED_LICENSES,
  ATTRIBUTION_REQUIRED,
  INGEST_SOURCES,
  sourceById,
  type IngestSource,
  type Modality,
} from './sources.js';

/** Private-agent owner. Set INGEST_AGENT_OWNER_ID to your user id. */
export const AGENT_OWNER_ENV = 'INGEST_AGENT_OWNER_ID';

/** True when the caller is the agent owner (or no owner pinned yet). */
export function isAgentOwner(userId: string): boolean {
  const owner = process.env[AGENT_OWNER_ENV];
  if (!owner) return true;
  return userId === owner;
}

/** Push cadence: upstream metadata check every minute, SSE heartbeat every second. */
export const UPSTREAM_TICK_MS = 60_000;
export const PUSH_HEARTBEAT_MS = 1_000;

export type TickAction = 'CACHE_HIT' | 'PULL' | 'BLOCKED' | 'UNKNOWN';

export interface SourceState {
  sourceId: string;
  lastHash: string | null;
  lastDna: string;
  lastTier: string;
  repairCount: number;
}

export interface RemoteHead {
  sourceId: string;
  revisionHash: string | null;
  dnaVersion: string;
  tier: string;
}

export interface TickDecision {
  sourceId: string;
  action: TickAction;
  reason: string;
}

const SECRET_SCAN: RegExp[] = [
  /(^|\/)\.[\w.-]*env(\.[\w.-]+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /credentials\.json$/i,
  /(^|\/)(token|secret|apikey|api_key)s?(\.[a-z]+)?$/i,
  /sk-(live|test)-[A-Za-z0-9]{8,}/,
  /AKIA[0-9A-Z]{16}/,
];

/** Gate·sentinel: license allow-list. Closed on unknown license. */
export function gateSourceLicense(source: IngestSource): { allowed: boolean; reason: string } {
  const ok = (ALLOWED_LICENSES as readonly string[]).includes(source.license);
  if (!ok) return { allowed: false, reason: `license_not_allowed:${source.license}` };
  return { allowed: true, reason: 'license_ok' };
}

export function licenseNeedsAttribution(source: IngestSource): boolean {
  return (ATTRIBUTION_REQUIRED as readonly string[]).includes(source.license);
}

/** Gate·sentinel: secret scan over a record name/payload. True = DENY. */
export function secretScanDeny(text: string): boolean {
  return SECRET_SCAN.some((re) => re.test(text));
}

/** Cache hit only if code-hash + DNA-version + tier all match, else Intake. */
export function isCacheHit(state: SourceState, remote: RemoteHead): boolean {
  if (!state.lastHash || !remote.revisionHash) return false;
  return (
    state.lastHash === remote.revisionHash &&
    state.lastDna === remote.dnaVersion &&
    state.lastTier === remote.tier
  );
}

export function decideForSource(state: SourceState, remote: RemoteHead): TickDecision {
  const source = sourceById(remote.sourceId);
  if (!source) return { sourceId: remote.sourceId, action: 'UNKNOWN', reason: 'unknown_source' };
  const gate = gateSourceLicense(source);
  if (!gate.allowed) return { sourceId: source.id, action: 'BLOCKED', reason: gate.reason };
  if (state.repairCount >= 3) return { sourceId: source.id, action: 'BLOCKED', reason: 'repair_max_3_escalate' };
  if (!remote.revisionHash) return { sourceId: source.id, action: 'UNKNOWN', reason: 'revision_unresolved' };
  if (isCacheHit(state, remote)) return { sourceId: source.id, action: 'CACHE_HIT', reason: 'hash_dna_tier_match' };
  return { sourceId: source.id, action: 'PULL', reason: 'hash_changed' };
}

/**
 * Minute tick over all sources. Cheap metadata compare only.
 * Dispatch·maker rule: at most ONE PULL per tick (winner runs, no ensemble).
 * Priority: GATE/SCOUT boxes first (cheap), then CODER/PLANNER/VERIFY.
 */
export function tickSources(states: SourceState[], remotes: RemoteHead[]): TickDecision[] {
  const boxRank: Record<string, number> = { GATE: 0, SCOUT: 1, CODER: 2, PLANNER: 3, VERIFY: 4 };
  const stateById = new Map(states.map((s) => [s.sourceId, s]));
  const ordered = [...INGEST_SOURCES].sort(
    (a, b) => (boxRank[a.box] ?? 9) - (boxRank[b.box] ?? 9),
  );
  const decisions: TickDecision[] = ordered.map((source) => {
    const state: SourceState = stateById.get(source.id) ?? {
      sourceId: source.id,
      lastHash: null,
      lastDna: '',
      lastTier: '',
      repairCount: 0,
    };
    const remote = remotes.find((r) => r.sourceId === source.id) ?? {
      sourceId: source.id,
      revisionHash: null,
      dnaVersion: '',
      tier: '',
    };
    return decideForSource(state, remote);
  });
  const firstPull = decisions.find((d) => d.action === 'PULL');
  return decisions.map((d) =>
    d.action === 'PULL' && d !== firstPull
      ? { ...d, action: 'CACHE_HIT' as TickAction, reason: 'deferred_next_tick' }
      : d,
  );
}

/** Resolve a HuggingFace dataset revision hash (HEAD only, no download). */
export async function fetchRemoteHead(source: IngestSource, dnaVersion: string, tier: string): Promise<RemoteHead> {
  const url = `https://huggingface.co/api/datasets/${source.hfDataset}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return { sourceId: source.id, revisionHash: null, dnaVersion, tier };
    const json = (await res.json()) as { sha?: string; id?: string };
    const hash = typeof json.sha === 'string' && json.sha.length >= 7 ? json.sha : null;
    return { sourceId: source.id, revisionHash: hash, dnaVersion, tier };
  } catch {
    return { sourceId: source.id, revisionHash: null, dnaVersion, tier };
  } finally {
    clearTimeout(timer);
  }
}

export function hashRecord(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

/** sha256 for binary image payloads before any Blob write. */
export function hashMedia(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Gate·sentinel for image/media URLs: https only, no secret-looking strings,
 * no local/private hosts. Fail-closed: unknown → deny.
 */
export function gateMediaUrl(url: string): { allowed: boolean; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'media_url_unparseable' };
  }
  if (parsed.protocol !== 'https:') return { allowed: false, reason: 'media_url_not_https' };
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    host.startsWith('169.254.') ||
    host === '[::1]'
  ) {
    return { allowed: false, reason: 'media_url_private_host' };
  }
  if (secretScanDeny(url)) return { allowed: false, reason: 'media_url_secret_pattern' };
  return { allowed: true, reason: 'media_url_ok' };
}

export interface MediaRecord {
  modality: Modality;
  storageKey: string | null;
  url: string | null;
  sha256: string;
}

/** Verify a media record before Blob write: hash present + URL gated. */
export function verifyMediaRecord(media: MediaRecord): { pass: boolean; reason: string } {
  if (!media.sha256 || media.sha256.length < 16) return { pass: false, reason: 'media_hash_missing' };
  if (media.url) {
    const gate = gateMediaUrl(media.url);
    if (!gate.allowed) return { pass: false, reason: gate.reason };
  }
  if (!media.storageKey && !media.url) return { pass: false, reason: 'media_nowhere_to_read' };
  return { pass: true, reason: 'media_verified' };
}

export type PushEventType = 'hello' | 'heartbeat' | 'tick' | 'blocked';

/**
 * Strict scout-route parser (serving-side contract).
 * The ship bar tolerates ≤10% malformed scout output at TRAINING time; at
 * SERVING time every malformed route fails CLOSED to the operator — no
 * regex rescue, no guessing. Rescue paths hide model decay; a counted
 * rejection teaches it. Requires JSON object with exact-enum lane + risk.
 */
export const SCOUT_LANES = ['CODER', 'PLANNER', 'FASTQA'] as const;
export const SCOUT_RISKS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

export type ScoutRoute = { lane: (typeof SCOUT_LANES)[number]; risk: (typeof SCOUT_RISKS)[number] };

export function parseScoutRoute(text: string): { ok: true; route: ScoutRoute } | { ok: false; reason: string } {
  let obj: unknown;
  try {
    obj = JSON.parse(text.trim());
  } catch {
    return { ok: false, reason: 'route_not_json' };
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false, reason: 'route_not_object' };
  }
  const { lane, risk } = obj as Record<string, unknown>;
  if (typeof lane !== 'string' || !(SCOUT_LANES as readonly string[]).includes(lane)) {
    return { ok: false, reason: 'route_bad_lane' };
  }
  if (typeof risk !== 'string' || !(SCOUT_RISKS as readonly string[]).includes(risk)) {
    return { ok: false, reason: 'route_bad_risk' };
  }
  return { ok: true, route: { lane: lane as ScoutRoute['lane'], risk: risk as ScoutRoute['risk'] } };
}

export interface PushEvent {
  event: PushEventType;
  agent: string;
  seq: number;
  at: string;
  data: Record<string, unknown>;
}

/** SSE push payload: heartbeat every second, full tick every minute. */
export function buildPushEvent(
  type: PushEventType,
  seq: number,
  data: Record<string, unknown> = {},
): PushEvent {
  return { event: type, agent: AGENT_NAME, seq, at: new Date().toISOString(), data };
}

export function formatSse(event: PushEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function ledgerDetail(source: IngestSource, action: TickAction, reason: string): Record<string, unknown> {
  return {
    agent: AGENT_NAME,
    source: source.id,
    hfDataset: source.hfDataset,
    license: source.license,
    box: source.box,
    action,
    reason,
    attributionRequired: licenseNeedsAttribution(source),
  };
}

/** Persist one tick decision to ingest_runs + audit log (fail-open on audit). */
export async function persistDecision(input: {
  userId: string;
  projectId: string;
  sourceId: string;
  action: TickAction;
  reason: string;
  fromHash: string | null;
  toHash: string | null;
}): Promise<void> {
  const source = sourceById(input.sourceId);
  const { withTenant } = await import('../../shared/db.js');
  const { newId, PREFIX } = await import('../../shared/ids.js');
  await withTenant(input.userId, async (q) => {
    await q.query(
      `INSERT INTO ingest_runs (id, project_id, source_id, action, from_hash, to_hash, verdict, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        newId(PREFIX.JOB),
        input.projectId,
        input.sourceId,
        input.action,
        input.fromHash,
        input.toHash,
        input.action === 'BLOCKED' ? 'FAIL' : 'PASS',
        JSON.stringify(
          source ? ledgerDetail(source, input.action, input.reason) : { agent: AGENT_NAME, reason: input.reason },
        ),
      ],
    );
  }).catch(() => undefined);
  const { recordAudit } = await import('../audit/service.js');
  await recordAudit({
    action: 'ingest.tick',
    actorUserId: input.userId,
    scope: 'USER',
    tenantId: input.projectId,
    resourceType: 'ingest_source',
    resourceId: input.sourceId,
    detail: { agent: AGENT_NAME, ...input },
  });
}
