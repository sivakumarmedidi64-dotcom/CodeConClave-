/**
 * CodeConClave — Agent Sai Srinivasa Athreya · unit tests.
 * Pure-function only: no DB, no network.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { INGEST_SOURCES, sourceModalities } from './sources.js';
import {
  buildPushEvent,
  decideForSource,
  fetchArxivHead,
  fetchGithubTrendingHead,
  fetchHackerNewsHead,
  fetchStackExchangeHead,
  formatSse,
  gateMediaUrl,
  gateSourceLicense,
  hashMedia,
  isAgentOwner,
  isCacheHit,
  isCronSecretOk,
  parseScoutRoute,
  secretScanDeny,
  tickSources,
  verifyMediaRecord,
} from './service.js';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.INGEST_CRON_SECRET;
});

describe('Agent Sai Srinivasa Athreya', () => {
  it('registers 29 final sources (19 HF + 10 endpoint-watched)', () => {
    expect(INGEST_SOURCES).toHaveLength(29);
  });

  it('gates unknown licenses closed', () => {
    expect(gateSourceLicense({ id: 'x', name: 'x', hfDataset: 'x', license: 'GPL-3.0', tier: 'T1_SAFE', box: 'CODER' }).allowed).toBe(false);
    expect(gateSourceLicense(INGEST_SOURCES[0]).allowed).toBe(true);
  });

  it('denies secret-like records', () => {
    expect(secretScanDeny('config/.env')).toBe(true);
    expect(secretScanDeny('AKIAIOSFODNN7EXAMPLE')).toBe(true);
    expect(secretScanDeny('src/coder/plan.ts')).toBe(false);
  });

  it('cache-hits only on hash+dna+tier match', () => {
    const state = { sourceId: 'a', lastHash: 'h1', lastDna: 'v1', lastTier: 'standard', repairCount: 0 };
    expect(isCacheHit(state, { sourceId: 'a', revisionHash: 'h1', dnaVersion: 'v1', tier: 'standard' })).toBe(true);
    expect(isCacheHit(state, { sourceId: 'a', revisionHash: 'h2', dnaVersion: 'v1', tier: 'standard' })).toBe(false);
    expect(isCacheHit(state, { sourceId: 'a', revisionHash: 'h1', dnaVersion: 'v2', tier: 'standard' })).toBe(false);
  });

  it('escalates after 3 repairs and runs one pull per tick', () => {
    const d = decideForSource(
      { sourceId: INGEST_SOURCES[0].id, lastHash: 'h', lastDna: 'v1', lastTier: 'standard', repairCount: 3 },
      { sourceId: INGEST_SOURCES[0].id, revisionHash: 'h2', dnaVersion: 'v1', tier: 'standard' },
    );
    expect(d.action).toBe('BLOCKED');
    const states = INGEST_SOURCES.map((s) => ({ sourceId: s.id, lastHash: 'old', lastDna: 'v1', lastTier: 'standard', repairCount: 0 }));
    const remotes = INGEST_SOURCES.map((s) => ({ sourceId: s.id, revisionHash: 'new', dnaVersion: 'v1', tier: 'standard' }));
    const pulls = tickSources(states, remotes).filter((x) => x.action === 'PULL');
    expect(pulls).toHaveLength(1);
  });

  it('is private: owner gate honors INGEST_AGENT_OWNER_ID', () => {
    const prev = process.env.INGEST_AGENT_OWNER_ID;
    delete process.env.INGEST_AGENT_OWNER_ID;
    expect(isAgentOwner('anyone')).toBe(true);
    process.env.INGEST_AGENT_OWNER_ID = 'usr_owner1';
    expect(isAgentOwner('usr_owner1')).toBe(true);
    expect(isAgentOwner('usr_stranger')).toBe(false);
    if (prev === undefined) delete process.env.INGEST_AGENT_OWNER_ID;
    else process.env.INGEST_AGENT_OWNER_ID = prev;
  });

  it('all 19 sources carry text+image modalities', () => {
    for (const s of INGEST_SOURCES) {
      expect(sourceModalities(s)).toEqual(['text', 'image']);
    }
  });

  it('gates media urls closed: https + public host + no secrets', () => {
    expect(gateMediaUrl('https://huggingface.co/datasets/x/preview.png').allowed).toBe(true);
    expect(gateMediaUrl('http://huggingface.co/x.png').allowed).toBe(false);
    expect(gateMediaUrl('https://169.254.169.254/keys').allowed).toBe(false);
    expect(gateMediaUrl('https://cdn.example.com/.env').allowed).toBe(false);
    expect(gateMediaUrl('not-a-url').allowed).toBe(false);
  });

  it('verifies media records before blob write', () => {
    const sha = hashMedia('bytes');
    expect(verifyMediaRecord({ modality: 'image', storageKey: 'k', url: null, sha256: sha }).pass).toBe(true);
    expect(verifyMediaRecord({ modality: 'image', storageKey: null, url: null, sha256: sha }).pass).toBe(false);
    expect(verifyMediaRecord({ modality: 'image', storageKey: null, url: 'http://x/y.png', sha256: sha }).pass).toBe(false);
  });

  it('builds per-second push events as SSE frames', () => {
    const e = buildPushEvent('heartbeat', 7, { projectId: 'prj_1' });
    expect(e.agent).toContain('Athreya');
    expect(formatSse(e).startsWith('event: heartbeat\ndata: ')).toBe(true);
  });

  it('parses scout routes strictly: malformed fails closed, never rescued', () => {
    const good = parseScoutRoute('{"lane":"CODER","risk":"HIGH"}');
    expect(good.ok).toBe(true);
    expect(parseScoutRoute('```json\n{"lane":"CODER","risk":"HIGH"}\n```').ok).toBe(false);
    expect(parseScoutRoute('{"lane":"CODER"}').ok).toBe(false);
    expect(parseScoutRoute('{"lane":"DESIGNER","risk":"LOW"}').ok).toBe(false);
    expect(parseScoutRoute('{"lane":"CODER","risk":"URGENT"}').ok).toBe(false);
    expect(parseScoutRoute('not json at all').ok).toBe(false);
    expect(parseScoutRoute('["CODER"]').ok).toBe(false);
  });

  it('checks arXiv by latest paper id, UNKNOWN on failure', async () => {
    const src = { id: 'arxiv-cs-se', name: 'x', hfDataset: 'arxiv:cs.SE', license: 'Permissive', tier: 'T1_SAFE', box: 'PLANNER', kind: 'arxiv', ref: 'cs.SE' } as const;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<feed><entry><id>http://arxiv.org/abs/2601.00001v1</id></entry></feed>' })) as never);
    const hit = await fetchArxivHead({ ...src }, 'v1', 'standard');
    expect(hit.revisionHash).toBe('arxiv:cs.SE:http://arxiv.org/abs/2601.00001v1');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })) as never);
    expect((await fetchArxivHead({ ...src }, 'v1', 'standard')).revisionHash).toBeNull();
  });

  it('checks GitHub trending by top repo id, UNKNOWN on rate limit', async () => {
    const src = { id: 'g', name: 'x', hfDataset: 'github-trending:python', license: 'Permissive', tier: 'T1_SAFE', box: 'CODER', kind: 'github-trending', ref: 'python' } as const;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: [{ id: 12345 }] }) })) as never);
    expect((await fetchGithubTrendingHead({ ...src }, 'v1', 'standard')).revisionHash).toBe('github:python:12345');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 })) as never);
    expect((await fetchGithubTrendingHead({ ...src }, 'v1', 'standard')).revisionHash).toBeNull();
  });

  it('checks StackExchange by newest question id, UNKNOWN on quota hit', async () => {
    const src = { id: 's', name: 'x', hfDataset: 'stackexchange:python', license: 'CC-BY-4.0', tier: 'T2_ATTRIBUTION', box: 'SCOUT', kind: 'stackexchange', ref: 'python' } as const;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: [{ question_id: 99 }] }) })) as never);
    expect((await fetchStackExchangeHead({ ...src }, 'v1', 'standard')).revisionHash).toBe('so:python:99');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout'); }) as never);
    expect((await fetchStackExchangeHead({ ...src }, 'v1', 'standard')).revisionHash).toBeNull();
  });

  it('checks HackerNews by feed head id, UNKNOWN on failure', async () => {
    const src = { id: 'h', name: 'x', hfDataset: 'hackernews:top', license: 'Permissive', tier: 'T1_SAFE', box: 'SCOUT', kind: 'hackernews', ref: 'top' } as const;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [424242, 1, 2] }) as never));
    expect((await fetchHackerNewsHead({ ...src }, 'v1', 'standard')).revisionHash).toBe('hn:top:424242');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ([]) }) as never));
    expect((await fetchHackerNewsHead({ ...src }, 'v1', 'standard')).revisionHash).toBeNull();
  });

  it('guards the cron tick: unset secret always denies', () => {
    delete process.env.INGEST_CRON_SECRET;
    expect(isCronSecretOk('anything')).toBe(false);
    process.env.INGEST_CRON_SECRET = 's3cret-cron-key';
    expect(isCronSecretOk('s3cret-cron-key')).toBe(true);
    expect(isCronSecretOk('wrong')).toBe(false);
    expect(isCronSecretOk(undefined)).toBe(false);
  });
});
